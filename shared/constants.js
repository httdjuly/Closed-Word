// Runtime constants shared verbatim by the Deno server and the browser client.
// Plain JS on purpose: the browser loads this file directly as an ES module,
// and the TypeScript server imports it too, so there is exactly one copy of
// every number that both sides have to agree on.

/** @typedef {"race" | "rounds" | "teams" | "coop" | "solo" | "monopoly"} GameMode */
/** @typedef {"easy" | "normal" | "hard"} Difficulty */
/** @typedef {"closeword" | "custom" | "ai" | "adult"} WordSource */
/** @typedef {"first" | "grace" | "everyone"} FinishRule */
/** @typedef {import("./protocol.ts").RoomConfig} RoomConfig */

/**
 * Two games live on this server, and the first thing anybody chooses is which
 * one. They share the room plumbing — codes, players, host, invites, chat, feed
 * — and nothing else: different setup screens, different rules, different
 * language on screen.
 *
 * Kept as data rather than two hard-coded screens so the landing page renders
 * the gate from this list, and adding a third game is a row here plus its own
 * setup view.
 */
export const GAMES = {
  closeword: {
    label: "CloseWord Party",
    icon: "🎭",
    tagline: "Semantic word-guessing races for a whole team.",
    blurb: "There is a secret word. Every guess is ranked by how close it is in " +
      "meaning. Five ways to play together, four sets of words.",
    lang: "en",
    /** Modes this game offers, in the order the picker shows them. */
    modes: ["race", "rounds", "teams", "coop", "solo"],
  },
  monopoly: {
    label: "Cờ tỷ phú Việt Nam",
    icon: "🎲",
    tagline: "Mua đường, xây nhà, thu tiền thuê — bằng tiếng Việt.",
    blurb: "Bàn cờ 40 ô là đường phố và địa danh của một thành phố Việt Nam. " +
      "Luật cờ tỷ phú tiêu chuẩn: mua, đấu giá, xây nhà, thế chấp, vào tù, phá sản.",
    lang: "vi",
    modes: ["monopoly"],
  },
};

/** @type {readonly (keyof typeof GAMES)[]} */
export const GAME_KEYS = ["closeword", "monopoly"];

/**
 * Which game a mode belongs to. The mode is the durable fact — it travels in the
 * room config and arrives with every snapshot — so the game is derived from it
 * rather than stored twice and allowed to disagree.
 *
 * @param {GameMode} mode
 * @returns {keyof typeof GAMES}
 */
export function gameOf(mode) {
  return mode === "monopoly" ? "monopoly" : "closeword";
}

/** @type {readonly GameMode[]} */
export const MODES = ["race", "rounds", "teams", "coop", "solo", "monopoly"];

/** The word-game modes, for pickers that are only about the word game. */
export const WORD_MODES = ["race", "rounds", "teams", "coop", "solo"];

export const MODE_INFO = {
  race: {
    label: "Free-for-all race",
    blurb: "Everyone hunts the same secret word at once. First to rank 1 wins; " +
      "the rest keep playing for placement.",
    boardScope: "player",
  },
  rounds: {
    label: "Round match",
    blurb: "Several races back to back. Points by finish order, cumulative leaderboard.",
    boardScope: "player",
  },
  teams: {
    label: "Teams",
    blurb: "Teammates share a guess board and can see each other's guesses. " +
      "First team to the word wins.",
    boardScope: "team",
  },
  coop: {
    label: "Co-op vs the clock",
    blurb: "One shared board, everyone against a timer. No winner, just a shared score.",
    boardScope: "all",
  },
  solo: {
    label: "Solo practice",
    blurb: "Just you. Starts the moment you create it, runs word after word for as " +
      "long as you like, and nobody else can join.",
    boardScope: "player",
    /**
     * A closed door, enforced on the server. Practice is the one mode where a
     * stranger with the room code turning up would ruin the thing being asked
     * for, so the room refuses a second player rather than trusting the UI to
     * hide the code.
     */
    solo: true,
  },
  monopoly: {
    label: "Cờ tỷ phú",
    blurb: "Bàn cờ 40 ô của một thành phố Việt Nam. Tung xúc xắc, mua đất, " +
      "xây nhà và thu tiền thuê cho tới khi chỉ còn một người.",
    /**
     * No guess boards at all. The word game builds a board per player, per team
     * or one for the room; the board game has one shared board that is the game,
     * so `boardScope` is meaningless here and nothing downstream asks for it.
     */
    boardScope: "none",
    board: true,
  },
};

/**
 * True for modes that play the board game rather than the word game.
 * @param {GameMode} mode
 * @returns {boolean}
 */
export function isBoardMode(mode) {
  return Boolean(MODE_INFO[mode]?.board);
}

/**
 * True for modes that are one person's own room.
 * @param {GameMode} mode
 * @returns {boolean}
 */
export function isSoloMode(mode) {
  return Boolean(MODE_INFO[mode]?.solo);
}

/**
 * Where secret words come from. This is independent of the game mode: any of the
 * five modes can be played with any of these four pools.
 *
 * All three are ranked by the same embedding table — a word source only decides
 * which words can be the *answer*, never how guesses are scored. That is why
 * guessing, hints and clues behave identically across sources.
 */
export const WORD_SOURCES = {
  closeword: {
    label: "CloseWord words",
    short: "CloseWord",
    blurb: "Everyday English, drawn from the most common words in the corpus. " +
      "Plays like closeword.org.",
    file: null,
  },
  custom: {
    label: "Custom words",
    short: "Custom",
    blurb: "Vocabulary harvested from a Confluence space you point the ingest at " +
      "— your own product and working language.",
    file: "data/words-custom.txt",
  },
  ai: {
    label: "AI-generated words",
    short: "AI",
    blurb: "A themed pool written by claude -p. Regenerate it any time with a " +
      "different theme.",
    file: "data/words-ai.txt",
  },
  adult: {
    label: "After dark (18+)",
    short: "18+",
    blurb: "Anatomy, sex and euphemism — cheeky rather than nasty. Everyone in " +
      "the room sees which set is in play, so pick it with the room, not at it.",
    file: "data/words-adult.txt",
    /**
     * Flagged so the UI can mark it and ask before switching to it. There is no
     * server-side switch on purpose: whoever is hosting knows their room, and a
     * deployment-wide ban would only mean somebody hosts the rude round somewhere
     * this server cannot see.
     */
    adult: true,
  },
};

/** @type {readonly (keyof typeof WORD_SOURCES)[]} */
export const WORD_SOURCE_KEYS = ["closeword", "custom", "ai", "adult"];

/**
 * True for word sets that need asking about before they go in a shared room.
 * @param {WordSource} source
 * @returns {boolean}
 */
export function isAdultSource(source) {
  return Boolean(WORD_SOURCES[source]?.adult);
}

/**
 * House rules for the end of a round — the three answers to "somebody found it,
 * now what?".
 *
 * These only bite when there is more than one board, so co-op ignores them
 * entirely. `grace` is the default because it is the only one of the three that
 * cannot stall: sudden death is over instantly, and `everyone` hands the room a
 * round that runs until the last person gives up. The host's "End round" button
 * is the escape hatch for that last case, which is exactly why it exists.
 *
 * @type {Record<FinishRule, { label: string, blurb: string }>}
 */
export const FINISH_RULES = {
  first: {
    label: "Sudden death",
    blurb: "The first board to find the word ends the round for everyone else, " +
      "right there.",
  },
  grace: {
    label: "Grace clock",
    blurb: "The first finisher starts a countdown. Everyone else races it for " +
      "the remaining places.",
  },
  everyone: {
    label: "Everyone finishes",
    blurb: "The round runs until every board has found the word. Nobody is cut " +
      "off — the host ends it by hand if somebody is stuck.",
  },
};

/** @type {readonly FinishRule[]} */
export const FINISH_KEYS = ["first", "grace", "everyone"];

/**
 * The lexicon size the rank scale is calibrated for, matching closeword.org.
 *
 * This one number sets the feel of the game, because a rank only means something
 * relative to how many words it was ranked against. A 50,000-word lexicon is
 * what makes a far guess land in the tens of thousands and every step toward the
 * answer a visible move — and, just as importantly, it is what makes ordinary
 * words guessable at all. A smaller lexicon built from corpus frequency drops
 * everyday nouns: at 10,000 words, one in five of the words in
 * scripts/coverage.ts was missing, including "spoon", "banana" and "pencil". At
 * 50,000 none are.
 *
 * `deno task ingest` defaults to this. Declared before DIFFICULTIES, which reads
 * it.
 */
export const REFERENCE_VOCAB = 50_000;

/**
 * Ranks above this are shown as "30000+" rather than a precise number, as
 * closeword does.
 *
 * Past this point the exact figure is noise: nobody can act on the difference
 * between 31,402 and 44,187, and a big precise number reads as though it means
 * something. The rank itself is never rounded — only the way it is displayed.
 */
export const RANK_DISPLAY_CAP = 30_000;

/**
 * Secret-word difficulty maps to how deep into the frequency-ordered pool we
 * draw from. Sized against REFERENCE_VOCAB: "hard" reaches the whole lexicon, so
 * the secret can be any word you could have guessed.
 */
export const DIFFICULTIES = {
  easy: { label: "Easy", poolLimit: 1500 },
  normal: { label: "Normal", poolLimit: 5000 },
  hard: { label: "Hard", poolLimit: REFERENCE_VOCAB },
};

/** @type {RoomConfig} */
export const DEFAULT_CONFIG = {
  mode: /** @type {GameMode} */ ("race"),
  /** Which pool the secret word is drawn from. Orthogonal to `mode`. */
  wordSource: /** @type {WordSource} */ ("closeword"),
  difficulty: /** @type {Difficulty} */ ("normal"),
  /** Number of rounds. Only meaningful for `rounds`; other modes always play 1. */
  totalRounds: 5,
  /** Number of teams. Only meaningful for `teams`. */
  teamCount: 2,
  /** 0 = untimed. Co-op ignores 0 and falls back to COOP_DEFAULT_SECONDS. */
  roundSeconds: 0,
  /**
   * Once the first board solves, everyone else gets this long to finish. Without
   * it a ten-player round stalls on whoever wandered off to get coffee.
   */
  graceSeconds: 90,
  hintsPerBoard: 3,
  /** Reveal the secret word to everyone once the round ends. */
  revealOnEnd: true,
  /** Ask `claude -p` for a natural-language clue when a board requests a hint. */
  aiClues: false,
  /** What happens once one board has found the word. See FINISH_RULES. */
  finish: /** @type {FinishRule} */ ("grace"),
  /** Let a board buy hints past its allowance, at the price of a round of drinks. */
  extraHints: true,
  /**
   * Guesses each board gets per round; 0 = unlimited. Hints are free, so a board
   * that spends its budget can still buy its way closer — which is the point.
   */
  guessLimit: 0,

  // --- monopoly ------------------------------------------------------------
  /** Which board. A built-in locality id, or "custom" once a host loads a file. */
  monoMap: "vietnam",
  /**
   * On by default because it is the printed rule and the one most tables get
   * wrong: without an auction, refusing to buy costs nothing and the cheap
   * squares sit empty all game.
   */
  monoAuction: true,
  /** Off by default: popular, but it makes games much longer. */
  monoParkingPot: false,
  /** Off by default, for the same reason. */
  monoDoubleGo: false,
};

export const LIMITS = {
  maxPlayers: 24,
  /**
   * Seats at the Monopoly board.
   *
   * Far below `maxPlayers`, and not an arbitrary cap: the board has eight colour
   * groups and forty squares, so a ninth player is a player who can never
   * complete a group, and a nine-way game is an hour of watching other people
   * roll. The room refuses the ninth rather than seating them.
   */
  maxBoardPlayers: 8,
  minBoardPlayers: 2,
  maxTeams: 6,
  minTeams: 2,
  maxRounds: 20,
  minRounds: 1,
  maxRoundSeconds: 3600,
  maxNicknameLength: 20,
  maxGuessLength: 32,
  maxChatLength: 200,
  maxGuessesPerBoard: 2000,
  /**
   * Ceiling for the *configurable* budget. Far below maxGuessesPerBoard, which
   * is an anti-abuse backstop rather than a house rule: a budget you can set to
   * 2000 is not a budget anybody would feel.
   */
  maxGuessBudget: 200,
  roomCodeLength: 6,
  /**
   * The biggest `monoMap` frame a client may send, in bytes.
   *
   * A board file is the one thing a client sends that is a document rather than
   * a sentence: the four boards that ship are 9–11KB, and "tải mẫu bản đồ" hands
   * one of them back as a starting point. Both sides need the same number — the
   * browser to refuse an oversized file next to the box it came from, the server
   * to enforce it — so it lives here rather than in either.
   */
  maxMapBytes: 64 * 1024,
  /** Per-player guess rate limit. */
  guessesPerWindow: 12,
  guessWindowMs: 5000,
};

/**
 * Rank tiers drive the colour and label of a guess row.
 *
 * Bands follow closeword's banding: the top hundred are unmistakably close, the
 * low thousands mean "right area", and past a few thousand a guess carries no
 * usable information — which is the same place the display cap starts hiding the
 * exact number.
 *
 * `at` is the inclusive upper bound at REFERENCE_VOCAB; `floor` is the smallest
 * bound worth using. Bounds scale with the pack actually loaded, because "rank
 * 600" means something completely different in a 50,000-word lexicon than in a
 * 700-word one — without scaling, a small pack paints everything warm.
 */
export const RANK_TIERS = [
  { at: 1, floor: 1, key: "found", label: "FOUND" },
  { at: 100, floor: 3, key: "scorching", label: "scorching" },
  { at: 600, floor: 8, key: "hot", label: "hot" },
  { at: 2500, floor: 20, key: "warm", label: "warm" },
  { at: 8000, floor: 50, key: "cool", label: "cool" },
];

export const COLD_TIER = { key: "cold", label: "cold" };

/**
 * A rank as text, with the display cap applied. Used by the server for the
 * standings detail lines and by the client for guess rows, so a player never sees
 * "30000+" in one place and "41,207" in another for the same guess.
 *
 * The locale is pinned rather than the viewer's, because these strings are also
 * built on the server and asserted in tests.
 *
 * @param {number} rank
 * @returns {string}
 */
export function formatRankValue(rank) {
  if (rank > RANK_DISPLAY_CAP) return `${RANK_DISPLAY_CAP.toLocaleString("en-US")}+`;
  return rank.toLocaleString("en-US");
}

/**
 * @param {number} rank
 * @param {number} [vocabSize]
 * @returns {{ key: string, label: string }}
 */
export function tierForRank(rank, vocabSize = REFERENCE_VOCAB) {
  const scale = Math.min(1, Math.max(0, vocabSize / REFERENCE_VOCAB));
  for (const tier of RANK_TIERS) {
    const bound = tier.at === 1 ? 1 : Math.max(tier.floor, Math.round(tier.at * scale));
    if (rank <= bound) return tier;
  }
  return COLD_TIER;
}

/**
 * Placement points for `rounds` mode: winner gets one point per participant,
 * each subsequent finisher one fewer, never below 1. Players who never solve
 * the round score 0.
 *
 * @param {number} place 1-based finish position
 * @param {number} participants
 * @returns {number}
 */
export function placementPoints(place, participants) {
  if (place < 1) return 0;
  return Math.max(1, participants - place + 1);
}

/**
 * Co-op score: starts at 2000, bleeds for every guess and every second spent.
 * Deliberately simple so the room can reason about whether they did well.
 *
 * @param {number} guesses
 * @param {number} elapsedSeconds
 * @returns {number}
 */
export function coopScore(guesses, elapsedSeconds) {
  return Math.max(0, Math.round(2000 - 15 * guesses - 2 * elapsedSeconds));
}

export const COOP_DEFAULT_SECONDS = 300;

/**
 * Co-op is defined by its clock, so it never runs untimed.
 * @param {RoomConfig} config
 * @returns {number}
 */
export function effectiveRoundSeconds(config) {
  // The board game runs on turns, not a clock. A countdown here would be a
  // deadline on somebody else's deliberation, which is not a rule of Monopoly.
  if (isBoardMode(config.mode)) return 0;
  if (config.mode === "coop") return config.roundSeconds || COOP_DEFAULT_SECONDS;
  return config.roundSeconds;
}

/**
 * `race` is by definition a single round; every other mode honours totalRounds.
 * @param {RoomConfig} config
 * @returns {number}
 */
export function effectiveTotalRounds(config) {
  // One game, played to a winner. Monopoly's own "round" — everyone has had a
  // turn — is counted by the game itself and is not a match structure.
  if (isBoardMode(config.mode)) return 1;
  if (config.mode === "race") return 1;
  // Practice is not a match with a finish line: it runs to the ceiling so there
  // is always another word waiting, and you stop by leaving rather than by
  // running out. Nothing is at stake, so nothing is lost by not finishing.
  if (isSoloMode(config.mode)) return LIMITS.maxRounds;
  return Math.max(1, Math.min(LIMITS.maxRounds, config.totalRounds));
}

/**
 * Which guess boards exist: one per player, one per team, one for the whole
 * room, or — in the board game — none at all.
 *
 * @param {GameMode} mode
 * @returns {"player" | "team" | "all" | "none"}
 */
export function boardScope(mode) {
  return /** @type {"player" | "team" | "all" | "none"} */ (
    MODE_INFO[mode]?.boardScope ?? "player"
  );
}

/**
 * Hint policy: each hint closes roughly half the remaining gap between the
 * board's best guess and the answer, so hints stay useful but never trivialise.
 *
 * @param {number} hintsUsed
 * @param {number | null} bestRank
 * @returns {number}
 */
export function hintTargetRank(hintsUsed, bestRank) {
  const ceiling = bestRank !== null && bestRank > 2 ? bestRank : 400;
  return Math.max(2, Math.round(ceiling * 0.5 ** (hintsUsed + 1)));
}

/**
 * What the hint button will actually do, phrased for the mode in play. Hints
 * belong to a *board*, so in shared-board modes they are spent on behalf of
 * everyone — players need telling, or the first person to click burns the room's
 * allowance without realising.
 *
 * @param {GameMode} mode
 * @param {number} hintsLeft
 * @param {number} hintsPerBoard
 * @returns {string}
 */
export function hintHelpText(mode, hintsLeft, hintsPerBoard) {
  if (hintsPerBoard === 0) return "Hints are switched off for this match.";
  const left = `${hintsLeft} of ${hintsPerBoard} left`;
  if (hintsLeft === 0) {
    return mode === "coop"
      ? "The room has used every hint."
      : mode === "teams"
      ? "Your team has used every hint."
      : "You have used every hint.";
  }
  switch (mode) {
    case "teams":
      return `Reveals a closer word on your team's board — ${left}, shared with your teammates.`;
    case "coop":
      return `Reveals a closer word on the shared board — ${left} for the whole room.`;
    default:
      return `Reveals a closer word on your board — ${left}, yours alone.`;
  }
}

/**
 * One buzz per player per this long. Buzz exists to interrupt people, so the
 * only interesting design question is how hard it is to abuse; ten seconds is
 * enough to get a quiet room's attention and not enough to grief with.
 */
export const BUZZ_COOLDOWN_MS = 10_000;

/** What an extra hint costs, phrased the way the button asks it. */
export const EXTRA_HINT_PROMPT =
  "Do you want another hint? By clicking this you will pay for everyone in the " +
  "room with a drink.";

/**
 * Reaction glyphs, shared so the feed and the players list cannot drift.
 *
 * Two of these are pantomime and two are shop talk. The Jira pair came from a
 * team who wanted the vocabulary they already argue in: calling something a
 * blocker is a specific accusation in a way that an egg is not, and landing it on
 * somebody's row mid-round is funny precisely because everyone knows what it
 * means on a real board.
 *
 * `title` is the button's tooltip — the glyphs alone are ambiguous once there are
 * four of them. `pile` is the feed line for a barrage: it takes the count and the
 * target, so each reaction can escalate in its own voice.
 */
export const REACTIONS = {
  rose: {
    glyph: "🌹",
    label: "rose",
    verb: "handed a rose to",
    title: "Give a rose",
    pile: (name, n) => `has buried ${name} in ${n} roses 🌹`,
  },
  egg: {
    glyph: "🥚",
    label: "egg",
    verb: "threw an egg at",
    title: "Throw an egg",
    pile: (name, n) => `is really letting ${name} have it — ${n} eggs 🥚`,
  },
  escalated: {
    glyph: "🚨",
    label: "escalation",
    verb: "escalated this to",
    title: "Escalate — critical, needs eyes now",
    pile: (name, n) => `has escalated ${n} times at ${name} — somebody wake the on-call 🚨`,
  },
  blocker: {
    glyph: "🚧",
    label: "blocker",
    verb: "flagged a blocker on",
    title: "Blocker — you are in the way",
    pile: (name, n) => `has ${name} down as blocking ${n} things 🚧`,
  },
};

/** @type {readonly ("rose" | "egg" | "escalated" | "blocker")[]} */
export const REACTION_KEYS = ["rose", "egg", "escalated", "blocker"];

/**
 * Throwing is unlimited on purpose — one egg is a comment, a dozen is a bit —
 * so the bounds here are about the machine rather than the joke.
 *
 * The window is a token bucket like the one on guesses: it lets somebody empty
 * the crate in a satisfying burst and then makes them wait, which is also the
 * funnier rhythm. The per-sender cap is what keeps the tally finite: the worst
 * case in a full room is 24 x 24 x REACTION_KEYS.length small integers, and a
 * number nobody can read is not worth storing.
 */
export const REACTION_WINDOW_MS = 4000;
export const REACTIONS_PER_WINDOW = 10;
export const REACTION_MAX_PER_SENDER = 99;

/**
 * How many from one person to one person before the room hears about it again.
 *
 * A feed line per throw would bury the chat under a barrage, and no line at all
 * would make a barrage invisible to anyone not looking at the right row. So the
 * first one is announced, and then it takes a pile to earn another mention.
 */
export const REACTION_FEED_MILESTONE = 5;

/** Room codes deliberately skip characters that are ambiguous when read aloud. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const TEAM_NAMES = ["Amber", "Cobalt", "Crimson", "Jade", "Violet", "Slate"];
