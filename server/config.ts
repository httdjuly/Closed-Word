// Server configuration, read from the environment once at startup.
//
// Everything here is an *operational* setting: ports, paths, timeouts, limits —
// things that differ between one person's laptop and the machine the team plays
// on. Game *rules* deliberately do not live here. Rank bands, hint policy, player
// caps and scoring stay in shared/constants.js, because the browser imports that
// file too and a rule the client and server disagreed about would be a bug no
// amount of configuration could fix.
//
// Values come from `.env` (loaded by `--env-file`, see deno.json) or the real
// environment, which wins. Every setting has a working default, so the server
// starts with no `.env` at all.
//
// Invalid values are collected and reported together, then the process exits.
// Silently falling back to a default would mean someone sets PORT=80O and spends
// ten minutes wondering why nobody can connect.

import { LIMITS } from "../shared/constants.js";

/** Collected so one bad `.env` produces one complete report, not a guessing game. */
const problems: string[] = [];

function raw(name: string): string | undefined {
  let value: string | undefined;
  try {
    value = Deno.env.get(name);
  } catch {
    // No --allow-env. Treat the whole environment as empty rather than crashing:
    // every setting has a default, so the server is still perfectly usable.
    return undefined;
  }
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function num(
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const value = raw(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    problems.push(`${name}=${value} is not a number`);
    return fallback;
  }
  const { min, max } = bounds;
  if (min !== undefined && parsed < min) {
    problems.push(`${name}=${value} is below the minimum of ${min}`);
    return fallback;
  }
  if (max !== undefined && parsed > max) {
    problems.push(`${name}=${value} is above the maximum of ${max}`);
    return fallback;
  }
  return parsed;
}

function str(name: string, fallback: string): string {
  return raw(name) ?? fallback;
}

function optional(name: string): string | undefined {
  return raw(name);
}

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

function bool(name: string, fallback: boolean): boolean {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  problems.push(`${name}=${value} is not a boolean (use true/false)`);
  return fallback;
}

function choice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`${name}=${value} must be one of ${allowed.join(", ")}`);
  return fallback;
}

export type ClaudeMode = "auto" | "off";

export interface Config {
  /** HTTP/WebSocket port. */
  port: number;
  /**
   * Bind address. The default binds every interface, which is what makes LAN
   * play work — narrow it to 127.0.0.1 to keep the server to this machine.
   */
  hostname: string;

  /** Embedding pack built by `deno task ingest`. */
  packPath: string;
  /** Curated secret-word pool for the CloseWord source. */
  secretPoolPath: string;
  /**
   * Rank tables held in memory. One is ~200 KB at 50k words and a room reuses
   * its table for a whole round, so this is really "how many concurrent rounds
   * stay fast".
   */
  rankCacheSize: number;

  claude: {
    /** `off` disables every `claude -p` feature: clues and the assistant. */
    mode: ClaudeMode;
    bin: string;
    /** Passed to `claude --model`; unset means the CLI's own default. */
    model: string | undefined;
    /** Assistant chat. Generous — a reply blocks nothing but its own bubble. */
    assistTimeoutMs: number;
    /** In-round clues. Impatient on purpose: a late clue is worthless. */
    clueTimeoutMs: number;
  };

  /**
   * Offline word curation (scripts/curate_words.ts). Nothing is waiting on it, and
   * vetting a batch of 100 words is a much bigger job than answering one question.
   */
  curateTimeoutMs: number;

  assist: {
    /**
     * The chat button. Off leaves in-round clues working and the Look tab fully
     * usable — appearance is all client-side — it only stops the conversation.
     *
     * Its own flag rather than `perMinute: 0`, because a cap of zero would make
     * every question fail as "too many questions", which is a confusing way to
     * report a deliberate decision.
     */
    enabled: boolean;
    /** Calls per player per minute. Each one forks a `claude` process. */
    perMinute: number;
    maxChars: number;
  };

  socket: {
    maxMessageBytes: number;
    /** The board-file ceiling: a document, not a sentence. See the default. */
    maxMapBytes: number;
    /** Flood guard per socket, independent of the in-game guess rate limit. */
    msgLimit: number;
    msgWindowMs: number;
    /** Coalescing window, so a burst of guesses sends one snapshot. */
    broadcastDebounceMs: number;
  };

  rooms: {
    /** How long an empty room survives before being reaped. */
    idleTtlMs: number;
    sweepIntervalMs: number;
    maxRooms: number;
  };

  log: {
    dir: string;
    /**
     * `debug` additionally logs individual guesses. Off by default on purpose:
     * the host usually plays, and the host is the one reading the log.
     */
    level: "debug" | "info" | "warn" | "error";
    /** The active file is rolled aside once a write would take it past this. */
    maxBytes: number;
    /**
     * Day-files older than this are deleted automatically, at startup and then
     * once a day. 0 keeps everything, and nothing else bounds the directory.
     */
    keepDays: number;
    /** Mirror to the terminal as well as the file. */
    console: boolean;
    /** False makes this a console-only logger and writes nothing to disk. */
    toFile: boolean;
  };
}

export const config: Config = Object.freeze({
  port: num("PORT", 8791, { min: 1, max: 65535 }),
  hostname: str("HOST", "0.0.0.0"),

  packPath: str("CLOSEWORD_PACK", "data/vectors.bin"),
  secretPoolPath: str("CLOSEWORD_SECRET_POOL", "data/secret-words.txt"),
  rankCacheSize: num("CLOSEWORD_RANK_CACHE", 48, { min: 1, max: 4096 }),

  claude: Object.freeze({
    mode: choice("CLOSEWORD_AI_CLUES", ["auto", "off"] as const, "auto"),
    bin: str("CLOSEWORD_CLAUDE_BIN", "claude"),
    model: optional("CLOSEWORD_CLAUDE_MODEL"),
    assistTimeoutMs: num("CLOSEWORD_ASSIST_TIMEOUT_MS", 90_000, { min: 1_000 }),
    clueTimeoutMs: num("CLOSEWORD_CLUE_TIMEOUT_MS", 30_000, { min: 1_000 }),
  }),

  curateTimeoutMs: num("CLOSEWORD_CURATE_TIMEOUT_MS", 180_000, { min: 1_000 }),

  assist: Object.freeze({
    enabled: bool("CLOSEWORD_ASSISTANT", true),
    perMinute: num("CLOSEWORD_ASSIST_PER_MINUTE", 10, { min: 1, max: 240 }),
    maxChars: num("CLOSEWORD_ASSIST_MAX_CHARS", 500, { min: 20, max: 4000 }),
  }),

  socket: Object.freeze({
    maxMessageBytes: num("CLOSEWORD_MAX_MESSAGE_BYTES", 4096, { min: 256 }),
    // A board file is a document rather than a sentence, so it gets its own
    // ceiling; every other message stays under the one above. The default is the
    // shared constant the browser checks against before it sends, so raising
    // this env var only ever makes the server the more permissive of the two.
    maxMapBytes: num("CLOSEWORD_MAX_MAP_BYTES", LIMITS.maxMapBytes, { min: 4_096 }),
    msgLimit: num("CLOSEWORD_SOCKET_MSG_LIMIT", 60, { min: 1 }),
    msgWindowMs: num("CLOSEWORD_SOCKET_MSG_WINDOW_MS", 5_000, { min: 100 }),
    broadcastDebounceMs: num("CLOSEWORD_BROADCAST_DEBOUNCE_MS", 20, { min: 0, max: 1_000 }),
  }),

  rooms: Object.freeze({
    idleTtlMs: num("CLOSEWORD_ROOM_IDLE_MINUTES", 20, { min: 1 }) * 60_000,
    sweepIntervalMs: num("CLOSEWORD_ROOM_SWEEP_SECONDS", 60, { min: 5 }) * 1_000,
    maxRooms: num("CLOSEWORD_MAX_ROOMS", 500, { min: 1 }),
  }),

  log: Object.freeze({
    dir: str("CLOSEWORD_LOG_DIR", "logs"),
    level: choice("CLOSEWORD_LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
    // 64 KB floor: below that the rotation machinery costs more than it saves.
    maxBytes: num("CLOSEWORD_LOG_MAX_BYTES", 2_000_000, { min: 64_000 }),
    keepDays: num("CLOSEWORD_LOG_KEEP_DAYS", 5, { min: 0, max: 3_650 }),
    console: bool("CLOSEWORD_LOG_CONSOLE", true),
    toFile: bool("CLOSEWORD_LOG_TO_FILE", true),
  }),
}) as Config;

/**
 * Report and exit if anything in the environment was unusable.
 *
 * Called explicitly by the server rather than at import time, so that importing
 * this module — from a script or a test — can never kill the process.
 */
export function assertConfigValid(): void {
  if (problems.length === 0) return;
  console.error(
    `\nBad configuration in .env or the environment:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\n\nSee .env.example for the accepted values.\n`,
  );
  Deno.exit(1);
}

/**
 * Anything a human would want confirmed in the boot banner.
 *
 * `hasAi` is false in a build with no Claude integration compiled in, and the
 * `claude` line is dropped rather than shown as disabled: naming a binary the
 * build cannot invoke sends whoever is reading the banner looking for a setting
 * that would not change anything.
 */
export function configSummary(hasAi = true): string[] {
  return [
    `listen    ${config.hostname}:${config.port}`,
    `pack      ${config.packPath}`,
    ...(hasAi
      ? [
        `claude    ${
          config.claude.mode === "off" ? "disabled by CLOSEWORD_AI_CLUES=off" : config.claude.bin
        }` +
        (config.claude.model ? ` (model ${config.claude.model})` : ""),
      ]
      : []),
    `log       ${
      config.log.toFile
        ? `${config.log.dir}/ at ${config.log.level}, rotating daily and past ` +
          `${Math.round(config.log.maxBytes / 1000)} kB`
        : `console only, at ${config.log.level}`
    }`,
  ];
}
