#!/usr/bin/env -S deno run --allow-net
/**
 * Drive a real server over real WebSockets with a roomful of bots. This is the
 * transport-level counterpart to tests/room_test.ts: it checks that ten
 * concurrent clients get correct, redacted, timely snapshots — the thing unit
 * tests on `Room` cannot prove.
 *
 *   deno task sim                                  # 10 players, race mode
 *   deno task sim --mode teams --players 12
 *   deno task sim --mode rounds --rounds 3 --url http://192.168.1.20:8791
 *
 * Bots guess from a fixed word list, so they usually will not stumble on the
 * answer; the host ends each round on a timer instead. Exits non-zero on the
 * first broken expectation.
 */

const WORDS = [
  "cat",
  "dog",
  "horse",
  "bird",
  "fish",
  "bee",
  "bear",
  "lion",
  "bread",
  "cheese",
  "apple",
  "potato",
  "coffee",
  "dinner",
  "sugar",
  "salt",
  "rain",
  "snow",
  "storm",
  "sun",
  "cloud",
  "house",
  "room",
  "door",
  "city",
  "bridge",
  "office",
  "car",
  "train",
  "plane",
  "boat",
  "bicycle",
  "road",
  "meeting",
  "manager",
  "salary",
  "contract",
  "deadline",
  "email",
  "computer",
  "software",
  "server",
  "database",
  "password",
  "internet",
  "tree",
  "flower",
  "mountain",
  "river",
  "forest",
  "ocean",
  "desert",
  "hand",
  "head",
  "leg",
  "heart",
  "bone",
  "doctor",
  "happy",
  "sad",
  "anger",
  "fear",
  "love",
  "surprise",
  "football",
  "tennis",
  "swimming",
  "chess",
  "music",
  "guitar",
  "song",
  "concert",
  "shirt",
  "shoe",
  "hat",
  "fabric",
  "money",
  "bank",
  "market",
  "price",
  "shop",
  "book",
  "word",
  "story",
  "puzzle",
  "morning",
  "hour",
  "past",
  "winter",
];

/**
 * Reserved exclusively for the rate-limit probe. On shared-board modes the other
 * bots would otherwise have already played these words, and a duplicate is
 * rejected before it counts against the limiter — so the probe would never trip.
 * Needs more entries than LIMITS.guessesPerWindow.
 */
const FLOOD_WORDS = [
  "kitten",
  "feline",
  "tabby",
  "purr",
  "whiskers",
  "paw",
  "meow",
  "puppy",
  "canine",
  "hound",
  "beagle",
  "terrier",
  "leash",
  "pony",
  "stallion",
  "mare",
  "foal",
  "gallop",
];

interface Args {
  url: string;
  players: number;
  mode: string;
  /** Word source: closeword | custom | ai. */
  source: string;
  rounds: number;
  roundSeconds: number;
  guessDelayMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: Deno.env.get("CLOSEWORD_URL") ?? "http://127.0.0.1:8791",
    players: 10,
    mode: "race",
    source: "closeword",
    rounds: 2,
    roundSeconds: 12,
    guessDelayMs: 260,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--url":
        args.url = value;
        i++;
        break;
      case "--players":
        args.players = Number(value);
        i++;
        break;
      case "--mode":
        args.mode = value;
        i++;
        break;
      case "--source":
        args.source = value;
        i++;
        break;
      case "--rounds":
        args.rounds = Number(value);
        i++;
        break;
      case "--seconds":
        args.roundSeconds = Number(value);
        i++;
        break;
      case "--delay":
        args.guessDelayMs = Number(value);
        i++;
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return args;
}

const args = parseArgs(Deno.args);

// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(condition: unknown, description: string): void {
  if (condition) {
    console.log(`  ok    ${description}`);
  } else {
    console.error(`  FAIL  ${description}`);
    failures.push(description);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One bot: a socket, its latest snapshot, and a guessing loop. */
class Bot {
  readonly name: string;
  readonly id: string;
  socket!: WebSocket;
  state: Record<string, unknown> | null = null;
  snapshots = 0;
  guessResults: { accepted: boolean; rank?: number; reason?: string }[] = [];
  errors: string[] = [];
  #wordOffset: number;
  #next = 0;

  constructor(index: number) {
    this.name = `bot${index + 1}`;
    // Player ids must match the server's /^[A-Za-z0-9_-]{8,64}$/.
    this.id = `simbot${String(index).padStart(4, "0")}`;
    // Stagger the word lists so bots do not all guess in lockstep.
    this.#wordOffset = (index * 7) % WORDS.length;
  }

  connect(base: string): Promise<void> {
    const wsUrl = base.replace(/^http/, "ws") + `/ws?id=${this.id}`;
    this.socket = new WebSocket(wsUrl);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: connect timed out`)), 8000);
      this.socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`${this.name}: socket error`));
      };
      this.socket.onmessage = (event) => this.#onMessage(String(event.data));
    });
  }

  #onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.errors.push("unparseable frame");
      return;
    }
    switch (msg.t) {
      case "state":
        this.state = msg.room as Record<string, unknown>;
        this.snapshots++;
        break;
      case "guessResult":
        this.guessResults.push(msg as never);
        break;
      case "error":
        this.errors.push(String(msg.message));
        break;
    }
  }

  send(message: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** Fire one guess from this bot's slice of the word list. */
  guessOnce(): void {
    const word = WORDS[(this.#wordOffset + this.#next) % WORDS.length];
    this.#next++;
    this.send({ t: "guess", word });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  get phase(): string {
    return String((this.state as { phase?: string } | null)?.phase ?? "none");
  }

  get board(): { guesses: unknown[]; hintsLeft: number; id: string; solved: boolean } | null {
    return (this.state as { board?: never } | null)?.board ?? null;
  }

  get players(): { id: string; guessCount: number; bestRank: number | null }[] {
    return (this.state as { players?: never } | null)?.players ?? [];
  }
}

/**
 * Probe the guard rails: the per-player guess limiter and the parser's tolerance
 * for junk. Must be called during a live round.
 */
async function checkLimits(guests: Bot[]): Promise<void> {
  console.log("  -- limits --");
  const flooder = guests[2];
  // On a shared board the bots occasionally blunder into the answer, which
  // closes the board and makes every later guess "closed" rather than
  // "tooFast". Say so instead of failing at random.
  if (flooder?.board?.solved || flooder?.phase !== "playing") {
    console.log("  skip  rate-limit probe (board already solved this round)");
  } else if (flooder) {
    const before = flooder.guessResults.length;
    // More attempts than LIMITS.guessesPerWindow (12), but fewer than the
    // socket-level flood cap (60), so we isolate the in-game limiter.
    for (const word of FLOOD_WORDS) flooder.send({ t: "guess", word });
    await delay(700);
    const results = flooder.guessResults.slice(before);
    const accepted = results.filter((r) => r.accepted).length;
    const reasons = new Map<string, number>();
    for (const r of results) {
      if (r.accepted) continue;
      reasons.set(r.reason ?? "?", (reasons.get(r.reason ?? "?") ?? 0) + 1);
    }
    const breakdown = [...reasons].map(([k, v]) => `${k}x${v}`).join(" ");
    check(
      results.some((r) => r.reason === "tooFast"),
      `the per-player guess rate limit engages under a burst ` +
        `(${accepted} accepted; ${breakdown || "none rejected"})`,
    );
  }

  const stray = guests[3];
  if (stray) {
    stray.send({ t: "nonsense" });
    stray.socket.send("{ not json");
    await delay(300);
    check(stray.socket.readyState === WebSocket.OPEN, "malformed messages do not kill the socket");
    check(stray.errors.length > 0, "malformed messages are reported back as errors");
  }
}

/** Wait until `predicate` holds, polling cheaply. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(60);
  }
  console.error(`  (timed out waiting for ${what})`);
  return false;
}

// ---------------------------------------------------------------------------

console.log(`\nCloseWord simulation — ${args.players} players, ${args.mode} mode`);
console.log(`server: ${args.url}\n`);

const info = await (await fetch(`${args.url}/api/info`)).json();
console.log(
  `server reports ${info.ranker.vocabSize} words` +
    (info.ranker.sample ? " (sample pack)" : "") + "\n",
);

const bots = Array.from({ length: args.players }, (_, i) => new Bot(i));
await Promise.all(bots.map((b) => b.connect(args.url)));
console.log(`connected ${bots.length} sockets`);

const [host, ...guests] = bots;

// --- create and join --------------------------------------------------------

host.send({
  t: "create",
  nickname: host.name,
  config: {
    mode: args.mode,
    wordSource: args.source,
    totalRounds: args.rounds,
    roundSeconds: args.roundSeconds,
    graceSeconds: 5,
    hintsPerBoard: 3,
  },
});

await waitFor(() => host.state !== null, 5000, "host snapshot");
const code = String((host.state as { code?: string })?.code ?? "");
console.log(`\nroom ${code} created`);
check(/^[A-Z0-9]{6}$/.test(code), "room code is six uppercase characters");

// The word source is orthogonal to the mode, so confirm the server honoured it
// rather than silently falling back to the default pool.
const appliedSource = (host.state as { config?: { wordSource?: string } })?.config?.wordSource;
check(appliedSource === args.source, `word source is "${args.source}" (got "${appliedSource}")`);
const sourceStatus =
  (host.state as { wordSources?: { key: string; available: boolean; size: number }[] })
    ?.wordSources?.find((s) => s.key === args.source);
check(
  sourceStatus?.available === true,
  `word source "${args.source}" is playable (${sourceStatus?.size ?? 0} words)`,
);

for (const bot of guests) bot.send({ t: "join", code, nickname: bot.name });
const everyoneIn = await waitFor(
  () => bots.every((b) => b.players.length === bots.length),
  8000,
  "all players visible to everyone",
);
check(everyoneIn, `all ${bots.length} players appear in every roster`);
check(host.errors.length === 0, "host saw no protocol errors");

// --- play the rounds --------------------------------------------------------

for (let round = 1; round <= args.rounds; round++) {
  console.log(`\n--- round ${round} ---`);
  if (round === 1) host.send({ t: "start" });
  else host.send({ t: "next" });

  const started = await waitFor(
    () => bots.every((b) => b.phase === "playing"),
    8000,
    "round start",
  );
  check(started, `round ${round}: every client entered the playing phase`);
  if (!started) break;

  check(
    bots.every((b) => b.board !== null),
    `round ${round}: every player has a board`,
  );

  // Nobody should ever receive the answer while the round is live.
  const leaked = bots.filter((b) => {
    const round = (b.state as { round?: { secret?: string | null } })?.round;
    return round?.secret != null;
  });
  check(leaked.length === 0, `round ${round}: the secret is not sent to any client mid-round`);

  // Everyone hammers guesses concurrently for a while.
  const guessRounds = 6;
  for (let i = 0; i < guessRounds; i++) {
    for (const bot of bots) bot.guessOnce();
    await delay(args.guessDelayMs);
  }
  guests[0]?.send({ t: "hint" });
  await delay(400);

  const accepted = bots.map((b) => b.guessResults.filter((r) => r.accepted).length);
  check(accepted.every((n) => n > 0), `round ${round}: every bot got ranks back`);

  const ranksSane = bots.every((b) =>
    b.guessResults.filter((r) => r.accepted).every((r) =>
      typeof r.rank === "number" && r.rank >= 1 && r.rank <= info.ranker.vocabSize
    )
  );
  check(ranksSane, `round ${round}: all ranks are within the vocabulary`);

  // Redaction: in per-player modes nobody may see another board's guesses.
  if (args.mode === "race" || args.mode === "rounds") {
    const ownGuessesOnly = bots.every((b) => {
      const mine = b.guessResults.filter((r) => r.accepted).length;
      const onBoard = b.board?.guesses.length ?? 0;
      // Own accepted guesses, plus at most the hint this bot requested.
      return onBoard <= mine + 1;
    });
    check(ownGuessesOnly, `round ${round}: boards contain only the owner's guesses`);
  }

  // Everyone should see everyone else's guess counts climbing.
  const liveProgress = host.players.filter((p) => p.guessCount > 0).length;
  check(
    liveProgress === bots.length,
    `round ${round}: host sees all ${bots.length} players' progress (saw ${liveProgress})`,
  );

  // Limits have to be probed while the round is live, otherwise guesses are
  // rejected as "closed" before they ever reach the rate limiter.
  if (round === 1) await checkLimits(guests);

  host.send({ t: "endRound" });
  const ended = await waitFor(
    () => bots.every((b) => b.phase === "roundEnd" || b.phase === "matchEnd"),
    8000,
    "round end",
  );
  check(ended, `round ${round}: every client left the playing phase`);

  const revealed = bots.filter((b) =>
    (b.state as { round?: { secret?: string | null } })?.round?.secret != null
  ).length;
  check(revealed === bots.length, `round ${round}: the answer is revealed to everyone at the end`);

  if (args.mode === "race") break; // race is a single round by definition
}

// --- reconnect --------------------------------------------------------------

console.log("\n--- reconnect ---");
const victim = guests[1];
if (victim) {
  const before = victim.snapshots;
  victim.close();
  await delay(500);
  await victim.connect(args.url);
  victim.send({ t: "join", code, nickname: victim.name });
  const back = await waitFor(() => victim.snapshots > before, 6000, "snapshot after reconnect");
  check(back, "a reconnecting player is put back in the room");
  check(
    victim.players.length === bots.length,
    `roster is intact after a reconnect (${victim.players.length}/${bots.length})`,
  );
}

// --- teardown ---------------------------------------------------------------

for (const bot of bots) bot.close();
await delay(400);

const health = await (await fetch(`${args.url}/healthz`)).json();
console.log(`\nserver still healthy: ${JSON.stringify(health)}`);
check(health.ok === true, "server is healthy after the run");

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  Deno.exit(1);
}
console.log("all checks passed");
