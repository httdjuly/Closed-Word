// Emit a production tree with no Claude integration in it.
//
//   deno task build:prod                 # -> dist/
//   deno task build:prod --out ./release # somewhere else
//   deno task build:prod --with-pack     # include the 58 MB data/vectors.bin
//   deno task build:prod --force         # overwrite an existing output directory
//
// ## What "no Claude" means here
//
// Not "the feature is switched off" — switched-off code is still code, and it is
// still `claude -p` waiting for an environment variable to change its mind. This
// drops the files:
//
//   server/ai.ts             the only module that spawns a subprocess
//   scripts/curate_words.ts  offline pool vetting, needs the binary
//   scripts/generate_words.ts   the AI word pool, needs the binary
//
// and sets CLOSEWORD_AI=off in the emitted deno.json so the server does not even
// look for them. `server/ai_runtime.ts` falls back to `ai_off.ts`, every AI
// feature reports itself unavailable, and the game plays exactly as it does on a
// machine with no `claude` installed — which is a path the server has always had.
//
// The build then *verifies* that, rather than trusting it: it greps the emitted
// tree for anything that would spawn a process, and fails if it finds any.
//
// ## What is deliberately not here
//
// Bundling and minification. The server runs TypeScript straight off disk under
// Deno, so a "build" is a copy with things removed — there is nothing to compile,
// and pretending otherwise would add a step that can fail for no benefit.

const OUT_DEFAULT = "dist";

/** Files that exist only to talk to `claude`, and must not reach production. */
const CLAUDE_ONLY = [
  "server/ai.ts",
  "scripts/curate_words.ts",
  "scripts/generate_words.ts",
];

/** Top-level things a running server needs. Everything else is left behind. */
const INCLUDE_DIRS = ["server", "shared", "client", "scripts"];
const INCLUDE_FILES = ["README.md", ".env.example"];

/** Word pools are small and the game is useless without them. The pack is not. */
const DATA_ALWAYS = /^(pack\.json|words-.*\.txt|terms-.*\.txt)$/;

/** Never copied, whatever directory they turn up in. */
const SKIP_ALWAYS = /^(\.git|node_modules|logs|dist|tests|\.env)$/;

/**
 * Anything that could start a subprocess. Checked against the emitted tree as a
 * backstop: the exclusion list above is hand-maintained, and a new file that
 * shells out would otherwise slip into production unnoticed.
 *
 * Matched against code with comments stripped, and written as call syntax rather
 * than bare names — the first version of this flagged `ai_core.ts` for containing
 * the words "no `Deno.Command`" in a header comment explaining that it contains
 * no such call.
 */
const SPAWN_PATTERNS = [
  /\bnew\s+Deno\.Command\s*\(/,
  /\bDeno\.run\s*\(/,
  /["']node:child_process["']/,
  /require\s*\(\s*["']child_process["']\s*\)/,
];

interface Options {
  out: string;
  withPack: boolean;
  force: boolean;
}

function parseArgs(args: string[]): Options {
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : OUT_DEFAULT;
  if (!out) throw new Error("--out needs a directory");
  return {
    out,
    withPack: args.includes("--with-pack"),
    force: args.includes("--force"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Copy a directory, skipping the excluded files. Returns what it wrote. */
async function copyDir(from: string, to: string, skip: Set<string>): Promise<string[]> {
  const written: string[] = [];
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (SKIP_ALWAYS.test(entry.name)) continue;
    const src = `${from}/${entry.name}`;
    const dst = `${to}/${entry.name}`;
    if (skip.has(src)) continue;
    if (entry.isDirectory) {
      written.push(...await copyDir(src, dst, skip));
    } else if (entry.isFile) {
      await Deno.copyFile(src, dst);
      written.push(src);
    }
  }
  return written;
}

/**
 * The deno.json the emitted tree runs on.
 *
 * Rewritten rather than copied: the source one has tasks pointing at scripts this
 * build just deleted, and a task that cannot run is worse than one that is not
 * offered. CLOSEWORD_AI=off is baked in so the runtime never looks for ai.ts.
 */
function prodDenoJson(source: Record<string, unknown>): string {
  const perms =
    "--allow-net --allow-read --allow-write=logs --allow-env --allow-sys=networkInterfaces";
  return JSON.stringify(
    {
      ...source,
      tasks: {
        start: `CLOSEWORD_AI=off deno run --env-file=.env ${perms} server/main.ts`,
        ingest:
          "deno run --env-file=.env --allow-net --allow-read --allow-write --allow-env scripts/ingest_vectors.ts",
        coverage: "deno run --allow-read scripts/coverage.ts",
      },
      // No `--allow-run` anywhere above, on purpose: with the permission withheld
      // the runtime *cannot* spawn anything even if a future edit tries to.
    },
    null,
    2,
  ) + "\n";
}

async function build(options: Options): Promise<void> {
  const { out } = options;

  if (await exists(out)) {
    if (!options.force) {
      throw new Error(`${out} already exists — pass --force to replace it`);
    }
    await Deno.remove(out, { recursive: true });
  }

  const skip = new Set(CLAUDE_ONLY);
  await Deno.mkdir(out, { recursive: true });

  let copied = 0;
  for (const dir of INCLUDE_DIRS) {
    if (!await exists(dir)) continue;
    copied += (await copyDir(dir, `${out}/${dir}`, skip)).length;
  }
  for (const file of INCLUDE_FILES) {
    if (!await exists(file)) continue;
    await Deno.copyFile(file, `${out}/${file}`);
    copied++;
  }

  // Word pools always; the embedding pack only when asked, because it is 58 MB
  // and most deploy targets would rather build it on the host than push it.
  await Deno.mkdir(`${out}/data`, { recursive: true });
  let packIncluded = false;
  for await (const entry of Deno.readDir("data")) {
    if (!entry.isFile) continue;
    const wanted = DATA_ALWAYS.test(entry.name) ||
      (options.withPack && entry.name === "vectors.bin");
    if (!wanted) continue;
    await Deno.copyFile(`data/${entry.name}`, `${out}/data/${entry.name}`);
    if (entry.name === "vectors.bin") packIncluded = true;
    copied++;
  }

  const source = JSON.parse(await Deno.readTextFile("deno.json")) as Record<string, unknown>;
  await Deno.writeTextFile(`${out}/deno.json`, prodDenoJson(source));
  await Deno.mkdir(`${out}/logs`, { recursive: true });

  const offenders = await audit(out);
  if (offenders.length > 0) {
    throw new Error(
      `the build can still spawn processes:\n  ${offenders.join("\n  ")}\n` +
        "Add the file to CLAUDE_ONLY in scripts/build_prod.ts, or move the call out of it.",
    );
  }

  console.log(`\n  Production build -> ${out}`);
  console.log(`  ${"-".repeat(40)}`);
  console.log(`  files      ${copied}`);
  console.log(`  excluded   ${CLAUDE_ONLY.join(", ")}`);
  console.log(`  ai         off (no claude integration in this tree)`);
  console.log(
    `  pack       ${packIncluded ? "included" : "not included — run `deno task ingest`"}`,
  );
  console.log(`\n  cd ${out} && cp .env.example .env && deno task start\n`);
}

/**
 * Blank out comments and string bodies so the audit reads code, not prose.
 *
 * Characters are replaced with spaces rather than removed, to keep offsets — and
 * therefore any future line reporting — honest. Regex literals are not modelled;
 * a regex containing `//` could in principle confuse this, which would show up as
 * a false positive with a readable message rather than a silent miss.
 */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") out += " ", i++;
      continue;
    }
    if (two === "/*") {
      while (i < source.length && source.slice(i, i + 2) !== "*/") {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Keep the quotes themselves: the child_process patterns match on them.
      out += ch;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        // Module specifiers are the one string body worth reading.
        out += /[\w:/._-]/.test(source[i]!) ? source[i] : " ";
        i++;
      }
      out += source[i] ?? "";
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Scan the emitted tree for anything that could start a subprocess. */
async function audit(root: string): Promise<string[]> {
  const offenders: string[] = [];
  for await (const path of walk(root)) {
    if (!/\.(ts|js|mjs)$/.test(path)) continue;
    const code = codeOnly(await Deno.readTextFile(path));
    for (const pattern of SPAWN_PATTERNS) {
      if (pattern.test(code)) offenders.push(`${path} matches ${pattern}`);
    }
  }
  return offenders;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile) yield path;
  }
}

if (import.meta.main) {
  try {
    await build(parseArgs(Deno.args));
  } catch (err) {
    console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
    Deno.exit(1);
  }
}
