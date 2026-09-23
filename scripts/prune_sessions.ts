#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
//
// Delete the `claude -p` session transcripts and keep the interactive ones.
//
// Every `claude` invocation leaves a transcript in
// ~/.claude/projects/<project>/<session-uuid>.jsonl, plus a companion
// <session-uuid>/ directory holding cached tool results and any subagent
// transcripts. This project calls `claude -p` for clues, word curation and the
// in-game assistant, so a few evenings of play buries the handful of
// conversations you might actually want to reread under hundreds of one-shot
// prompts — and most of the disk.
//
// The two kinds are distinguishable. Every transcript's first user record
// carries how the session was started:
//
//   interactive (you, typing)   "entrypoint":"cli"      "promptSource":"typed"
//   one-shot (`claude -p`)      "entrypoint":"sdk-cli"  "promptSource":"sdk"
//
// Only `sdk-cli` is deleted. Anything this script cannot positively identify is
// reported and left alone, because the cost of being wrong is asymmetric: a
// stale one-shot transcript wastes disk, a deleted conversation is gone.
//
// It is a dry run unless you pass --delete.
//
//   deno task sessions:prune                     # show what would go
//   deno task sessions:prune --delete            # actually remove it
//   deno task sessions:prune --project closeword # this project only
//   deno task sessions:prune --older-than 7      # leave the last week alone

import { basename, join } from "@std/path";

/** A session file is named for its UUID. Nothing else is ever a candidate. */
export const SESSION_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
export const SESSION_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The entrypoint value that means "one shot, from a program". Set rather than a
 * string because there is more than one non-interactive front end and being
 * conservative here means only deleting what we recognise.
 */
const ONE_SHOT_ENTRYPOINTS = new Set(["sdk-cli"]);

/**
 * How far into a transcript to look for the classifying record. It sits on the
 * first user turn, which in practice is line 4 — but a large pasted first prompt
 * can stretch a line, so scan by line rather than by byte and stop early.
 */
const CLASSIFY_LINE_LIMIT = 200;

/**
 * Never delete a transcript touched this recently.
 *
 * The game calls `claude -p` while it is running, so a prune during a match would
 * otherwise pull a transcript out from under a live subprocess. Nothing depends on
 * these files, so the damage is small — but "small" is not a reason to do it, and
 * a minute costs nothing.
 */
const IN_FLIGHT_GRACE_MS = 60_000;

export type Kind = "one-shot" | "interactive" | "unknown";

interface Session {
  project: string;
  /** Bare UUID, without the .jsonl. */
  id: string;
  file: string;
  /** Companion directory, if it exists. */
  dir: string | null;
  kind: Kind;
  entrypoint: string | null;
  bytes: number;
  mtime: Date | null;
  /** Set when the session is a candidate but something spares it. */
  spared: string | null;
}

interface Args {
  root: string;
  project: string | null;
  olderThanDays: number | null;
  del: boolean;
  list: boolean;
}

function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    console.error("Could not find your home directory (HOME / USERPROFILE unset).");
    console.error("Pass the location explicitly:  --root <path-to>/.claude/projects");
    Deno.exit(2);
  }
  return home;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: join(homeDir(), ".claude", "projects"),
    project: null,
    olderThanDays: null,
    del: false,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      // `deno task` needs no separator and passes a bare `--` straight through as
      // an argument, so accept it rather than answering a habit with an error.
      case "--":
        break;
      case "--root":
        args.root = argv[++i] ?? "";
        break;
      case "--project":
        args.project = (argv[++i] ?? "").toLowerCase();
        break;
      case "--older-than": {
        const days = Number(argv[++i]);
        if (!Number.isFinite(days) || days < 0) {
          console.error(`--older-than wants a number of days, got ${argv[i]}`);
          Deno.exit(2);
        }
        args.olderThanDays = days;
        break;
      }
      case "--delete":
        args.del = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "-h":
      case "--help":
        console.log(HELP);
        Deno.exit(0);
        break;
      default:
        console.error(`Unknown flag: ${flag}\n`);
        console.log(HELP);
        Deno.exit(2);
    }
  }
  return args;
}

const HELP = `Delete \`claude -p\` session transcripts, keeping interactive conversations.

Usage: deno task sessions:prune [options]

  --delete             Actually remove them. Without this it is a dry run.
  --project <text>     Only projects whose directory name contains <text>.
  --older-than <days>  Skip sessions touched more recently than this.
  --list               Print every session, not just the totals.
  --root <path>        Where the transcripts live.
                       Default: ~/.claude/projects
  -h, --help           This.

Only files named <uuid>.jsonl are ever considered, and only those whose first
user record says entrypoint=sdk-cli are removed. Sessions that cannot be
classified are reported and kept.`;

/**
 * Read just enough of a transcript to see how the session was started.
 *
 * Streams and stops at the first record that says, so a 10 MB transcript costs
 * one buffer read rather than a full parse.
 */
export async function classify(path: string): Promise<{ kind: Kind; entrypoint: string | null }> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return { kind: "unknown", entrypoint: null };
  }

  const decoder = new TextDecoder();
  const buffer = new Uint8Array(64 * 1024);
  let pending = "";
  let lines = 0;

  try {
    while (lines < CLASSIFY_LINE_LIMIT) {
      const read = await file.read(buffer);
      // A zero-length read should not happen on a regular file, but treating it
      // as anything other than the end would spin here forever.
      const atEof = read === null || read === 0;
      if (read !== null && read > 0) {
        pending += decoder.decode(buffer.subarray(0, read), { stream: true });
      }

      // On EOF the trailing fragment is a whole line; otherwise hold it back.
      const chunks = pending.split("\n");
      pending = atEof ? "" : (chunks.pop() ?? "");

      for (const line of chunks) {
        if (++lines > CLASSIFY_LINE_LIMIT) break;
        if (line.trim() === "") continue;
        // Cheap reject before parsing: most records have no entrypoint at all.
        if (!line.includes('"entrypoint"')) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue; // A truncated line is not worth failing over.
        }
        const entrypoint = (record as { entrypoint?: unknown }).entrypoint;
        if (typeof entrypoint !== "string" || entrypoint === "") continue;
        return {
          kind: ONE_SHOT_ENTRYPOINTS.has(entrypoint) ? "one-shot" : "interactive",
          entrypoint,
        };
      }

      if (atEof) break;
    }
  } finally {
    file.close();
  }
  return { kind: "unknown", entrypoint: null };
}

/** Total bytes under a directory. Used only for the reclaimed-space figure. */
async function dirBytes(path: string): Promise<number> {
  let total = 0;
  try {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory) {
        total += await dirBytes(child);
      } else if (entry.isFile) {
        try {
          total += (await Deno.stat(child)).size;
        } catch {
          // Vanished mid-walk; it is not going to be reclaimed either way.
        }
      }
    }
  } catch {
    // Unreadable subtree: report 0 rather than abandoning the whole scan.
  }
  return total;
}

async function collect(args: Args): Promise<{ sessions: Session[]; projects: number }> {
  const sessions: Session[] = [];
  let projects = 0;

  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(args.root)) entries.push(entry);
  } catch (err) {
    console.error(`Cannot read ${args.root}: ${err instanceof Error ? err.message : err}`);
    Deno.exit(2);
  }

  const cutoff = args.olderThanDays === null ? null : Date.now() - args.olderThanDays * 86_400_000;
  // Never delete the transcript being written right now, whatever it says.
  const currentId = (Deno.env.get("CLAUDE_SESSION_ID") ?? "").trim().toLowerCase();

  for (const project of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!project.isDirectory) continue;
    if (args.project && !project.name.toLowerCase().includes(args.project)) continue;
    projects++;

    const projectPath = join(args.root, project.name);
    const files: string[] = [];
    const dirs = new Set<string>();
    for await (const entry of Deno.readDir(projectPath)) {
      // memory/ lives alongside the sessions and is not one. The UUID patterns
      // already exclude it; this stays explicit because it is the one directory
      // here whose loss would actually hurt.
      if (entry.name === "memory") continue;
      if (entry.isFile && SESSION_FILE_RE.test(entry.name)) files.push(entry.name);
      else if (entry.isDirectory && SESSION_DIR_RE.test(entry.name)) dirs.add(entry.name);
    }

    for (const name of files.sort()) {
      const id = basename(name, ".jsonl");
      const file = join(projectPath, name);
      const { kind, entrypoint } = await classify(file);

      let bytes = 0;
      let mtime: Date | null = null;
      try {
        const info = await Deno.stat(file);
        bytes = info.size;
        mtime = info.mtime;
      } catch {
        continue; // Gone since the listing.
      }

      const dir = dirs.has(id) ? join(projectPath, id) : null;
      if (dir) bytes += await dirBytes(dir);

      let spared: string | null = null;
      if (kind === "one-shot") {
        if (id.toLowerCase() === currentId) spared = "this session";
        else if (mtime !== null && Date.now() - mtime.getTime() < IN_FLIGHT_GRACE_MS) {
          spared = "written in the last minute — may still be running";
        } else if (cutoff !== null && mtime !== null && mtime.getTime() > cutoff) {
          spared = "too recent";
        }
      }

      sessions.push({
        project: project.name,
        id,
        file,
        dir,
        kind,
        entrypoint,
        bytes,
        mtime,
        spared,
      });
    }
  }

  return { sessions, projects };
}

export function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function pad(text: string | number, width: number): string {
  return String(text).padStart(width);
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  const { sessions, projects } = await collect(args);

  if (sessions.length === 0) {
    console.log(
      `No sessions found under ${args.root}${args.project ? ` matching "${args.project}"` : ""}.`,
    );
    return;
  }

  const doomed = sessions.filter((s) => s.kind === "one-shot" && s.spared === null);
  const kept = sessions.filter((s) => s.kind === "interactive");
  const sparedList = sessions.filter((s) => s.spared !== null);
  const unknown = sessions.filter((s) => s.kind === "unknown");

  console.log(`\n${args.root}`);
  console.log(`${projects} project(s), ${sessions.length} session(s)\n`);

  // Per project, so a wrong --project is obvious before anything is removed.
  const byProject = new Map<string, Session[]>();
  for (const s of sessions) {
    const list = byProject.get(s.project) ?? [];
    list.push(s);
    byProject.set(s.project, list);
  }
  for (const [project, list] of byProject) {
    const one = list.filter((s) => s.kind === "one-shot" && s.spared === null);
    const bytes = one.reduce((sum, s) => sum + s.bytes, 0);
    console.log(
      `  ${project}\n` +
        `    ${pad(one.length, 4)} claude -p    ${pad(human(bytes), 9)}\n` +
        `    ${pad(list.filter((s) => s.kind === "interactive").length, 4)} interactive\n` +
        (list.some((s) => s.spared)
          ? `    ${pad(list.filter((s) => s.spared).length, 4)} spared\n`
          : "") +
        (list.some((s) => s.kind === "unknown")
          ? `    ${pad(list.filter((s) => s.kind === "unknown").length, 4)} unclassified\n`
          : ""),
    );
  }

  if (args.list) {
    console.log("  sessions:");
    for (const s of sessions) {
      const mark = s.kind === "one-shot" ? (s.spared ? `spared: ${s.spared}` : "delete") : s.kind;
      const when = s.mtime ? s.mtime.toISOString().slice(0, 16).replace("T", " ") : "?";
      console.log(
        `    ${s.id}  ${when}  ${pad(human(s.bytes), 9)}  ${s.entrypoint ?? "-"}  ${mark}`,
      );
    }
    console.log("");
  }

  // Anything unreadable is called out by name — silence here would read as
  // "everything was handled", which is the opposite of the truth.
  if (unknown.length > 0) {
    console.log(`Could not classify ${unknown.length} session(s); leaving them alone:`);
    for (const s of unknown.slice(0, 10)) console.log(`  ${s.project}/${s.id}.jsonl`);
    if (unknown.length > 10) console.log(`  ... and ${unknown.length - 10} more`);
    console.log("");
  }
  if (sparedList.length > 0) {
    console.log(`Spared ${sparedList.length} one-shot session(s):`);
    for (const s of sparedList.slice(0, 10)) console.log(`  ${s.id} — ${s.spared}`);
    if (sparedList.length > 10) console.log(`  ... and ${sparedList.length - 10} more`);
    console.log("");
  }

  const reclaimable = doomed.reduce((sum, s) => sum + s.bytes, 0);
  const keptBytes = kept.reduce((sum, s) => sum + s.bytes, 0);

  if (doomed.length === 0) {
    console.log(
      `Nothing to prune. ${kept.length} interactive session(s) using ${human(keptBytes)}.`,
    );
    return;
  }

  if (!args.del) {
    console.log(
      `Dry run: ${doomed.length} claude -p session(s) would go, freeing ${human(reclaimable)}.\n` +
        `${kept.length} interactive session(s) (${human(keptBytes)}) would be kept.\n\n` +
        `Re-run with --delete to remove them.`,
    );
    return;
  }

  let removedFiles = 0;
  let removedDirs = 0;
  let freed = 0;
  const failures: string[] = [];

  for (const s of doomed) {
    // Directory first: a session file without its tool-results is still a
    // readable transcript, whereas the reverse is an orphan nothing points at.
    if (s.dir) {
      try {
        await Deno.remove(s.dir, { recursive: true });
        removedDirs++;
      } catch (err) {
        failures.push(`${s.dir}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
    }
    try {
      await Deno.remove(s.file);
      removedFiles++;
      freed += s.bytes;
    } catch (err) {
      failures.push(`${s.file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(
    `Deleted ${removedFiles} session file(s) and ${removedDirs} companion director(ies), ` +
      `freeing ${human(freed)}.`,
  );
  if (failures.length > 0) {
    console.log(`\n${failures.length} could not be removed:`);
    for (const f of failures.slice(0, 10)) console.log(`  ${f}`);
    if (failures.length > 10) console.log(`  ... and ${failures.length - 10} more`);
    Deno.exit(1);
  }
}

if (import.meta.main) await main();
