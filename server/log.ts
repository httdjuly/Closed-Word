// Structured logging to a rotating daily file.
//
// Four channels, because "what happened on that box last Friday" is nearly always
// one of four questions:
//
//   service   the process itself — start, config, shutdown, fatal errors
//   action    what people did — rooms created, players joining, rounds starting
//   http      inbound requests, including the WebSocket upgrade
//   webhook   outbound calls to anything external, today `claude -p`
//
// Errors are a *level*, not a channel, so a failure is filed next to the thing
// that failed: a `claude` timeout belongs with the other webhook lines, not in a
// separate error log you would have to correlate by timestamp.
//
// Two things are deliberately never written here.
//
// **The secret word.** This is a LAN game where the host usually plays too, and
// the host is the person with the log file. Anything written here is readable
// mid-round by exactly the player who must not read it.
//
// **Guesses, unless the level is `debug`.** The game's core privacy promise is
// that you never see another board's guesses; a log tailing them on the host's
// screen would quietly break that promise. `debug` exists for when you are
// genuinely diagnosing the ranker and nobody is playing for points.

import { join } from "@std/path";
import { config } from "./config.ts";

export type Level = "debug" | "info" | "warn" | "error";
export type Channel = "service" | "action" | "http" | "webhook";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

export interface LoggerOptions {
  /** Directory for log files. Created on demand. */
  dir: string;
  /** Lines below this level are dropped. */
  level: Level;
  /** Rotate the active file once it passes this. */
  maxBytes: number;
  /** Delete day-files older than this many days. 0 keeps everything. */
  keepDays: number;
  /** Also mirror to stdout/stderr. */
  console: boolean;
  /** Write to disk at all. False makes this a console logger. */
  toFile: boolean;
  /** Base filename, before the date. */
  prefix?: string;
}

export type Fields = Record<string, unknown>;

/**
 * Field names whose values never reach the file.
 *
 * A backstop, not the primary defence — the call sites are supposed to not pass
 * these in the first place. But a token in a log is the kind of mistake that is
 * discovered much later by someone else, so it is worth catching structurally.
 */
const SECRET_KEY_RE = /token|secret|password|passwd|authorization|auth|api[-_]?key|cookie/i;

/** Values needing quotes: anything that would make `key=value` ambiguous. */
const NEEDS_QUOTES_RE = /[\s"=]|^$/;

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  }
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return NEEDS_QUOTES_RE.test(text) ? JSON.stringify(text) : text;
}

export function formatFields(fields: Fields | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${SECRET_KEY_RE.test(key) ? "***" : formatValue(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** `2026-08-13T09:41:02.184Z INFO  service  listening addr=0.0.0.0:8791` */
export function formatLine(
  time: Date,
  level: Level,
  channel: Channel,
  message: string,
  fields?: Fields,
): string {
  const stamp = time.toISOString();
  // One line per event, always: a multi-line message would break every tool that
  // reads this file a line at a time, `grep` included.
  const flat = message.replace(/\s*\n\s*/g, " ⏎ ");
  return `${stamp} ${level.toUpperCase().padEnd(5)} ${channel.padEnd(7)} ${flat}${
    formatFields(fields)
  }`;
}

/** Local calendar day, because "yesterday's log" means the operator's yesterday. */
export function dayStamp(time: Date): string {
  const year = time.getFullYear();
  const month = `${time.getMonth() + 1}`.padStart(2, "0");
  const day = `${time.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Turn an unknown thrown value into fields worth keeping.
 *
 * The stack is the whole reason to log an error, but only its head: a Deno stack
 * runs to dozens of frames of internals, and the interesting part is always the
 * first few.
 */
export function errorFields(err: unknown, stackLines = 4): Fields {
  if (err instanceof Error) {
    const stack = (err.stack ?? "")
      .split("\n")
      .slice(1, 1 + stackLines)
      .map((line) => line.trim())
      .join(" | ");
    return { error: err.name, message: err.message, ...(stack ? { stack } : {}) };
  }
  return { error: "thrown", message: String(err) };
}

export class Logger {
  #options: LoggerOptions;
  #file: Deno.FsFile | null = null;
  #path: string | null = null;
  #day: string | null = null;
  /** Last day retention ran for, so the sweep happens once per day, not per line. */
  #sweptDay: string | null = null;
  #bytes = 0;
  /** Set after a write failure, so a broken disk cannot spam the console. */
  #broken = false;
  #encoder = new TextEncoder();

  constructor(options: Partial<LoggerOptions> = {}) {
    this.#options = {
      dir: "logs",
      level: "info",
      maxBytes: 2_000_000,
      keepDays: 5,
      console: true,
      toFile: true,
      prefix: "closeword",
      ...options,
    };
  }

  get options(): Readonly<LoggerOptions> {
    return this.#options;
  }

  /** The file currently being written, once one has been opened. */
  get path(): string | null {
    return this.#path;
  }

  enabled(level: Level): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.#options.level];
  }

  log(level: Level, channel: Channel, message: string, fields?: Fields): void {
    if (!this.enabled(level)) return;
    const line = formatLine(new Date(), level, channel, message, fields);

    if (this.#options.console) {
      // warn and error to stderr so `> out.log` still shows problems on screen.
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }

    if (!this.#options.toFile || this.#broken) return;
    try {
      this.#write(line);
    } catch (err) {
      this.#broken = true;
      this.#closeFile();
      // Console, not this logger: logging a logging failure through the logger is
      // how you get an infinite loop.
      const target = this.#path ?? this.#options.dir;
      // The tasks grant --allow-write=logs, so pointing CLOSEWORD_LOG_DIR
      // somewhere else fails here. Say so, rather than leaving someone to wonder
      // why the directory they configured stayed empty.
      const hint = err instanceof Deno.errors.NotCapable
        ? `\n       Deno was not granted write access to it. Widen the flag in ` +
          `deno.json:\n         --allow-write=${this.#options.dir}`
        : "";
      console.error(
        `[log] cannot write ${target}, continuing without a log file: ` +
          `${err instanceof Error ? err.message : err}${hint}`,
      );
    }
  }

  debug(channel: Channel, message: string, fields?: Fields): void {
    this.log("debug", channel, message, fields);
  }

  /** Process lifecycle: start, configuration, shutdown. */
  service(message: string, fields?: Fields): void {
    this.log("info", "service", message, fields);
  }

  /** Something a person did. */
  action(message: string, fields?: Fields): void {
    this.log("info", "action", message, fields);
  }

  /** An inbound request. */
  http(message: string, fields?: Fields): void {
    this.log("info", "http", message, fields);
  }

  /** An outbound call to something external. */
  webhook(message: string, fields?: Fields): void {
    this.log("info", "webhook", message, fields);
  }

  warn(channel: Channel, message: string, fields?: Fields): void {
    this.log("warn", channel, message, fields);
  }

  /** Errors keep their channel, so a failure files next to what failed. */
  error(channel: Channel, message: string, err?: unknown, fields?: Fields): void {
    this.log("error", channel, message, {
      ...(err === undefined ? {} : errorFields(err)),
      ...fields,
    });
  }

  /**
   * Present so callers can be explicit about wanting the log durable before they
   * exit. Writes are synchronous, so by the time `log(...)` returns the line is
   * already handed to the OS and there is nothing queued to wait for.
   */
  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#closeFile();
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------

  /**
   * Written synchronously, deliberately.
   *
   * An async write queue loses its tail exactly when it matters most. `Deno.serve`
   * installs its own SIGINT handler that exits the process, so on Ctrl-C the
   * shutdown line — and anything else still queued — never reached the disk. At
   * this volume a synchronous append is a few microseconds and the whole class of
   * "the log stops just before the interesting part" disappears with it.
   */
  #write(line: string): void {
    const bytes = this.#encoder.encode(`${line}\n`);
    this.#ensureFile(bytes.byteLength);
    if (!this.#file) return;
    // writeSync can report a short write; loop until the line is fully out.
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += this.#file.writeSync(bytes.subarray(offset));
    }
    this.#bytes += bytes.byteLength;
  }

  /** Open, roll over on a new day, or roll over on size — whichever applies. */
  #ensureFile(incoming: number): void {
    const today = dayStamp(new Date());

    if (this.#file && this.#day !== today) this.#closeFile();

    // Once a day, and once at startup — a box that is only switched on to play
    // would otherwise never cross a rollover and never delete anything.
    if (this.#sweptDay !== today) {
      this.#sweptDay = today;
      this.#sweepOldDays();
    }

    // Rotate *before* the write that would cross the line, so the active file is
    // never larger than maxBytes rather than never much larger.
    if (this.#file && this.#bytes + incoming > this.#options.maxBytes) {
      this.#closeFile();
      this.#rollAside(today);
    }

    if (this.#file) return;

    Deno.mkdirSync(this.#options.dir, { recursive: true });
    this.#day = today;
    this.#path = this.#dayPath(today);
    this.#file = Deno.openSync(this.#path, { write: true, create: true, append: true });
    this.#bytes = this.#file.statSync().size;

    // A restart onto an already-full file would otherwise append past the cap,
    // since the size check only runs on the next write.
    if (this.#bytes + incoming > this.#options.maxBytes) {
      this.#closeFile();
      this.#rollAside(today);
      this.#file = Deno.openSync(this.#path, { write: true, create: true, append: true });
      this.#bytes = 0;
    }
  }

  #dayPath(day: string): string {
    return join(this.#options.dir, `${this.#options.prefix}-${day}.log`);
  }

  /**
   * Move the full file aside as `-1`, `-2`, ... and start a fresh one.
   *
   * Rolling rather than truncating in place. Truncation throws away the lines
   * immediately before the moment the file filled up, which is reliably the
   * moment you most want to read about — a runaway loop hits the size cap
   * precisely because something has gone wrong.
   */
  #rollAside(day: string): void {
    const base = this.#dayPath(day);
    for (let part = 1; part < 1000; part++) {
      const candidate = base.replace(/\.log$/, `.${part}.log`);
      try {
        Deno.statSync(candidate);
        continue; // Taken; try the next number.
      } catch {
        Deno.renameSync(base, candidate);
        return;
      }
    }
    // A thousand parts in one day means something is very wrong; drop the file
    // rather than refusing to log anything further.
    try {
      Deno.removeSync(base);
    } catch {
      // Nothing better to do here than carry on.
    }
  }

  /**
   * Delete day-files past the retention window, including their rolled parts.
   *
   * Retention is the only thing bounding disk use. Without it a busy server can
   * write 2 MB parts indefinitely, and the failure mode — a full disk on the
   * machine everyone is playing on — is worse than losing last week's logs.
   */
  #sweepOldDays(): number {
    const { keepDays, dir, prefix } = this.#options;
    if (keepDays <= 0) return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const oldest = dayStamp(cutoff);
    const pattern = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})(\\.\\d+)?\\.log$`);
    let removed = 0;
    try {
      for (const entry of Deno.readDirSync(dir)) {
        if (!entry.isFile) continue;
        const match = pattern.exec(entry.name);
        // Date strings in this shape sort lexicographically, which is the whole
        // reason the filename uses it.
        if (match && match[1] < oldest) {
          try {
            Deno.removeSync(join(dir, entry.name));
            removed++;
          } catch {
            // In use, or gone already. Try again tomorrow.
          }
        }
      }
    } catch {
      // Directory unreadable or absent; retention is housekeeping, not a reason
      // to stop logging.
    }
    return removed;
  }

  /**
   * Run retention now and report how many files went. Exposed for the boot path
   * and for tests; the logger also does this itself, once a day.
   */
  sweep(): number {
    this.#sweptDay = dayStamp(new Date());
    return this.#sweepOldDays();
  }

  #closeFile(): void {
    try {
      this.#file?.close();
    } catch {
      // Already closed.
    }
    this.#file = null;
    this.#bytes = 0;
  }
}

/**
 * The process-wide logger, configured from `.env`.
 *
 * A singleton because the alternative is threading a logger through every
 * constructor in the server for no benefit — there is one process and one log.
 * Tests build their own `Logger` instead of touching this one.
 */
export const log: Logger = new Logger({
  dir: config.log.dir,
  level: config.log.level,
  maxBytes: config.log.maxBytes,
  keepDays: config.log.keepDays,
  console: config.log.console,
  toFile: config.log.toFile,
});
