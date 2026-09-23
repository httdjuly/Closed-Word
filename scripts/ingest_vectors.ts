#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write
/**
 * Build `data/vectors.bin` — the trimmed embedding table the game ranks against.
 *
 *   deno task ingest --sample                 # synthetic 64-d demo pack, instant
 *   deno task ingest                          # download fastText wiki-news, trim to 50k
 *   deno task ingest --limit 100000           # bigger vocabulary (~120 MB resident)
 *   deno task ingest --input path/to.vec      # use an already-downloaded file
 *
 * The upstream file is ~700 MB compressed and streams straight through the
 * filter, so peak memory is the output matrix, not the download.
 */

import { TextLineStream } from "@std/streams/text-line-stream";
import { encodePack, normaliseRow } from "../server/vectorpack.ts";
import { SAMPLE_DOMAINS } from "./sample_words.ts";

const DEFAULT_SOURCE =
  "https://dl.fbaipublicfiles.com/fasttext/vectors-english/wiki-news-300d-1M.vec.zip";

const OUT_PATH = "data/vectors.bin";
const MANIFEST_PATH = "data/pack.json";

interface Args {
  sample: boolean;
  limit: number;
  maxScan: number;
  input: string | null;
  source: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sample: false,
    /**
     * Matches REFERENCE_VOCAB in shared/constants.js, which is what calibrates
     * the rank scale to closeword.org. Change one and change the other, or ranks
     * stop meaning what the colours claim. Do not lower it much: at 10,000 words
     * a fifth of the everyday vocabulary in scripts/coverage.ts is missing.
     */
    limit: 50_000,
    maxScan: 400_000,
    input: null,
    source: DEFAULT_SOURCE,
    out: OUT_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--sample":
        args.sample = true;
        break;
      case "--limit":
        args.limit = Number(next());
        break;
      case "--max-scan":
        args.maxScan = Number(next());
        break;
      case "--input":
        args.input = next();
        break;
      case "--source":
        args.source = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "-h":
      case "--help":
        console.log(
          "usage: deno task ingest [--sample] [--limit N] [--max-scan N] " +
            "[--input FILE] [--source URL] [--out FILE]",
        );
        Deno.exit(0);
        break;
      default:
        throw new Error(`unknown flag ${a}`);
    }
  }
  if (!Number.isFinite(args.limit) || args.limit < 100) {
    throw new Error("--limit must be at least 100");
  }
  return args;
}

// ---------------------------------------------------------------------------
// Vocabulary filter
// ---------------------------------------------------------------------------

/**
 * fastText's vocabulary is raw corpus tokens: mixed case, punctuation, numerals,
 * URL fragments. We keep only plain lowercase alphabetic words, which is also
 * exactly the set a player can type.
 */
const WORD_RE = /^[a-z]{2,24}$/;

function acceptWord(word: string): boolean {
  return WORD_RE.test(word);
}

// ---------------------------------------------------------------------------
// Streaming input: plain / gzip / single-entry zip
// ---------------------------------------------------------------------------

/** Lets us read a few header bytes off a stream and then hand the remainder on. */
class Peeker {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async need(n: number): Promise<Uint8Array> {
    while (this.#buf.length < n) {
      const { value, done } = await this.#reader.read();
      if (done) throw new Error(`stream ended after ${this.#buf.length} bytes, needed ${n}`);
      const merged = new Uint8Array(this.#buf.length + value.length);
      merged.set(this.#buf);
      merged.set(value, this.#buf.length);
      this.#buf = merged;
    }
    return this.#buf.subarray(0, n);
  }

  consume(n: number): void {
    this.#buf = this.#buf.slice(n);
  }

  /** Remaining buffered bytes followed by everything still in the source. */
  rest(): ReadableStream<Uint8Array> {
    const leftover = this.#buf;
    this.#buf = new Uint8Array(0);
    const reader = this.#reader;
    let finished = false;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (leftover.length) controller.enqueue(leftover);
      },
      pull: async (controller) => {
        if (finished) return;
        const { value, done } = await reader.read();
        if (done) {
          finished = true;
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
  }
}

/**
 * Deno types `DecompressionStream.writable` as accepting `BufferSource`, which
 * does not structurally match `pipeThrough`'s `Uint8Array` pair. The runtime
 * behaviour is correct; only the declaration is too loose.
 */
function decompress(
  stream: ReadableStream<Uint8Array>,
  format: "gzip" | "deflate-raw",
): ReadableStream<Uint8Array> {
  const transform = new DecompressionStream(format) as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
  return stream.pipeThrough(transform);
}

/**
 * Unwrap a zip holding a single entry. We only need the local file header, not
 * the central directory, because there is exactly one member in the fastText
 * archives and it is the first thing in the file.
 */
async function unwrapZip(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const peeker = new Peeker(stream);
  const head = await peeker.need(30);
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const signature = hv.getUint32(0, true);
  if (signature !== 0x04034b50) {
    throw new Error(`not a zip local file header (0x${signature.toString(16)})`);
  }
  const method = hv.getUint16(8, true);
  const nameLen = hv.getUint16(26, true);
  const extraLen = hv.getUint16(28, true);
  await peeker.need(30 + nameLen + extraLen);
  const nameBytes = (await peeker.need(30 + nameLen)).subarray(30);
  console.log(`  zip entry: ${new TextDecoder().decode(nameBytes)} (method ${method})`);
  peeker.consume(30 + nameLen + extraLen);
  const body = peeker.rest();
  if (method === 0) return body;
  if (method === 8) return decompress(body, "deflate-raw");
  throw new Error(`unsupported zip compression method ${method}`);
}

async function openLines(args: Args): Promise<ReadableStream<string>> {
  let raw: ReadableStream<Uint8Array>;
  let name: string;

  if (args.input) {
    name = args.input;
    console.log(`reading ${name}`);
    raw = (await Deno.open(args.input, { read: true })).readable;
  } else {
    name = args.source;
    console.log(`downloading ${name}`);
    console.log("  (this is a large one-time download; ^C is safe, nothing is written yet)");
    const res = await fetch(args.source);
    if (!res.ok || !res.body) {
      throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    }
    const size = res.headers.get("content-length");
    if (size) console.log(`  ${(Number(size) / 1e6).toFixed(0)} MB`);
    raw = res.body;
  }

  const lower = name.toLowerCase();
  let decoded: ReadableStream<Uint8Array>;
  if (lower.endsWith(".zip")) {
    decoded = await unwrapZip(raw);
  } else if (lower.endsWith(".gz")) {
    decoded = decompress(raw, "gzip");
  } else {
    decoded = raw;
  }

  return decoded
    .pipeThrough(new TextDecoderStream("utf-8", { fatal: false }))
    .pipeThrough(new TextLineStream());
}

// ---------------------------------------------------------------------------
// Real ingest
// ---------------------------------------------------------------------------

async function ingestReal(args: Args): Promise<void> {
  const lines = await openLines(args);

  const words: string[] = [];
  let dim = 0;
  let matrix: Float32Array | null = null;
  let scanned = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for await (const line of lines) {
    if (!line) continue;
    scanned++;

    // fastText's first line is a "<count> <dim>" header.
    if (scanned === 1) {
      const header = line.split(" ");
      if (header.length === 2 && Number.isInteger(Number(header[1]))) {
        dim = Number(header[1]);
        console.log(`  header: ${header[0]} words, ${dim} dimensions`);
        continue;
      }
    }

    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const word = line.slice(0, sp);
    if (!acceptWord(word) || seen.has(word)) {
      skipped++;
      if (scanned >= args.maxScan) break;
      continue;
    }

    const parts = line.slice(sp + 1).trimEnd().split(" ");
    if (dim === 0) {
      dim = parts.length;
      console.log(`  inferred ${dim} dimensions`);
    }
    if (parts.length !== dim) {
      skipped++;
      continue;
    }
    if (!matrix) matrix = new Float32Array(args.limit * dim);

    const row = words.length * dim;
    for (let i = 0; i < dim; i++) matrix[row + i] = Number(parts[i]);
    normaliseRow(matrix, row, dim);
    seen.add(word);
    words.push(word);

    if (words.length % 10_000 === 0) {
      console.log(`  kept ${words.length} / scanned ${scanned}`);
    }
    if (words.length >= args.limit) break;
    if (scanned >= args.maxScan) break;
  }

  if (!matrix || words.length === 0) throw new Error("no vectors parsed — is the source correct?");
  console.log(`kept ${words.length} words (scanned ${scanned}, skipped ${skipped})`);

  const trimmed = matrix.subarray(0, words.length * dim);
  await writePack(args.out, words, trimmed, dim, false, args.input ?? args.source);
}

// ---------------------------------------------------------------------------
// Sample ingest: synthetic but semantically sane, so the game is playable
// before anyone downloads 700 MB.
// ---------------------------------------------------------------------------

/** Deterministic xorshift128 so repeated runs produce an identical pack. */
function makeRng(seed: number) {
  let x = seed | 0 || 0x9e3779b9;
  let y = 0x243f6a88;
  let z = 0xb7e15162;
  let w = 0x8aed2a6b;
  return () => {
    const t = x ^ (x << 11);
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19)) ^ (t ^ (t >>> 8));
    return ((w >>> 0) / 4294967296) * 2 - 1;
  };
}

function gaussianVec(dim: number, rng: () => number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    // Sum of three uniforms is a good enough normal for separating clusters.
    v[i] = (rng() + rng() + rng()) / 3;
  }
  return v;
}

function ingestSample(args: Args): Promise<void> {
  const dim = 64;
  const rng = makeRng(20260812);

  const words: string[] = [];
  const rows: Float32Array[] = [];

  for (const domain of SAMPLE_DOMAINS) {
    const domainVec = gaussianVec(dim, rng);
    for (const cluster of domain.clusters) {
      const clusterVec = gaussianVec(dim, rng);
      for (const word of cluster) {
        if (!acceptWord(word)) {
          console.warn(`  skipping unusable sample word ${JSON.stringify(word)}`);
          continue;
        }
        const jitter = gaussianVec(dim, rng);
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++) {
          v[i] = 2.0 * domainVec[i] + 1.35 * clusterVec[i] + 0.75 * jitter[i];
        }
        words.push(word);
        rows.push(v);
      }
    }
  }

  const seen = new Set<string>();
  const matrix = new Float32Array(words.length * dim);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (seen.has(words[i])) continue;
    seen.add(words[i]);
    const off = kept.length * dim;
    matrix.set(rows[i], off);
    normaliseRow(matrix, off, dim);
    kept.push(words[i]);
  }

  console.log(
    `built synthetic pack: ${kept.length} words, ${dim} dims, ` +
      `${SAMPLE_DOMAINS.length} domains`,
  );
  return writePack(
    args.out,
    kept,
    matrix.subarray(0, kept.length * dim),
    dim,
    true,
    "synthetic sample clusters",
  );
}

// ---------------------------------------------------------------------------

async function writePack(
  out: string,
  words: string[],
  matrix: Float32Array,
  dim: number,
  sample: boolean,
  source: string,
): Promise<void> {
  const bytes = encodePack(words, matrix, dim, sample);
  await Deno.mkdir("data", { recursive: true });
  await Deno.writeFile(out, bytes);
  const manifest = {
    source,
    words: words.length,
    dim,
    sample,
    bytes: bytes.length,
    createdAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${out} — ${(bytes.length / 1e6).toFixed(1)} MB`);
  if (sample) {
    console.log(
      "\nThis is the SAMPLE pack: the semantics are hand-built clusters, not real\n" +
        "embeddings. Great for testing the game; run `deno task ingest` without\n" +
        "--sample for real fastText vectors before playing for keeps.",
    );
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  if (args.sample) await ingestSample(args);
  else await ingestReal(args);
}
