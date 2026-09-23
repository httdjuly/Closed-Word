// Wire protocol between the browser client and the Deno WebSocket server.
//
// The server is authoritative for everything. After any state change it pushes a
// full `state` snapshot, redacted per recipient (you never receive another
// board's guesses). Snapshots are small — a 24-player room is a few KB — so
// full-snapshot broadcast buys us freedom from desync bugs at negligible cost.

/**
 * How a room plays.
 *
 * The first five are the word game and share every rule downstream — they differ
 * only in how many guess boards exist and who is attached to each. `monopoly` is
 * a different game entirely: no secret word, no boards, no ranks. It sits in the
 * same union because it is still a room on this server with players, a host, a
 * feed and a chat, and splitting the room plumbing in two to keep the enum tidy
 * would cost far more than this one asymmetric member does.
 */
export type GameMode = "race" | "rounds" | "teams" | "coop" | "solo" | "monopoly";

/** True for modes that play the board game rather than the word game. */
export function isBoardGame(mode: GameMode): boolean {
  return mode === "monopoly";
}
export type Difficulty = "easy" | "normal" | "hard";
/** Which pool the secret word is drawn from. Independent of `GameMode`. */
export type WordSource = "closeword" | "custom" | "ai" | "adult";

/**
 * What ends a round once somebody has found the word.
 *
 * `grace` is the historical behaviour and stays the default: the first finisher
 * starts a countdown for everybody else. The other two are the ends of that
 * spectrum — stop dead, or wait for the room.
 */
export type FinishRule = "first" | "grace" | "everyone";

/**
 * Thanks, a dig, or the two accusations a working team already throws at each
 * other. Kept as a closed union rather than a string so that adding a fifth means
 * visiting the glyph table, the CSS and this line together.
 */
export type ReactionKind = "rose" | "egg" | "escalated" | "blocker";

/** How many of one kind one person threw at another this round. */
export interface ReactionTally {
  nickname: string;
  count: number;
}

/**
 * What we can tell somebody about one English word.
 *
 * Every field past `word` is optional, and a note is only sent when at least one
 * of them survived validation — a panel with four blank rows reads as broken,
 * where three rows and a missing one reads as honest.
 */
export interface WordNote {
  word: string;
  /** IPA without slashes; the client draws those. */
  ipa?: string;
  /** Spelled out in full — "noun", not "n." — so the client can abbreviate. */
  pos?: string;
  /** The everyday sense, a dozen words at most. */
  meaning?: string;
  /** Vietnamese, because that is who asked for this. */
  vi?: string;
}

/**
 * Declared here rather than inferred from `DEFAULT_CONFIG` in constants.js:
 * type-checking is off for that file, so inference there would silently widen
 * every field to `any`. `sanitiseConfig` builds this object field by field, so
 * any drift between the two shows up as a compile error immediately.
 */
export interface RoomConfig {
  mode: GameMode;
  wordSource: WordSource;
  difficulty: Difficulty;
  totalRounds: number;
  teamCount: number;
  roundSeconds: number;
  graceSeconds: number;
  hintsPerBoard: number;
  revealOnEnd: boolean;
  aiClues: boolean;
  /** House rule for how a round ends once one board has solved it. */
  finish: FinishRule;
  /** Guesses each board gets per round. 0 = unlimited. Hints do not count. */
  guessLimit: number;
  /** Allow buying a hint past the allowance, at the price of a round of drinks. */
  extraHints: boolean;

  // --- monopoly ------------------------------------------------------------
  // Ignored by every word mode, and the word settings above are ignored by
  // monopoly. One flat config rather than a tagged union because `setConfig`
  // takes partial patches from the lobby, and a union would make every patch a
  // discriminated-narrowing exercise for no gain.

  /** Which board: a built-in locality id, or `custom` for one the host loaded. */
  monoMap: string;
  /** A declined square goes to auction, as the printed rules say. */
  monoAuction: boolean;
  /** House rule: fines pile up under Bãi đỗ xe for whoever lands there. */
  monoParkingPot: boolean;
  /** House rule: landing exactly on Xuất phát pays double. */
  monoDoubleGo: boolean;
}

export type Phase = "lobby" | "playing" | "roundEnd" | "matchEnd";

export interface Guess {
  n: number;
  word: string;
  rank: number;
  byPlayerId: string;
  byNickname: string;
  at: number;
  /** True for rows the board received from a hint rather than a player's guess. */
  hint?: boolean;
  /**
   * An emoji for what the word means, when the server is confident enough to pick
   * one. Absent for most words — see server/wordicon.ts for why a blank beats a
   * guess. Decoration and orientation only: it never encodes rank or heat.
   */
  icon?: string;
}

export interface BoardView {
  id: string;
  label: string;
  /** Only ever populated for boards the recipient belongs to. */
  guesses: Guess[];
  hintsLeft: number;
  solved: boolean;
  bestRank: number | null;
  /** Latest AI clue for this board, if one was requested. */
  clue: string | null;
}

export interface PublicPlayer {
  id: string;
  nickname: string;
  connected: boolean;
  isHost: boolean;
  teamId: number | null;
  /** Best rank this round. Visible to everyone — that tension is the point. */
  bestRank: number | null;
  guessCount: number;
  solved: boolean;
  /** Finish position this round, 1-based; null until they solve. */
  place: number | null;
  /** Cumulative match score. */
  score: number;
  /** Board game: in the room, watching, with no seat at the table. */
  spectator?: boolean;
  /** Board game: their turns are being played for them. */
  auto?: boolean;
  /**
   * What was thrown at them this round, by kind, and who by. One entry per
   * sender, so the array is the tally *and* the hover detail with nothing to keep
   * in sync, and its length is bounded by the room size however hard people throw.
   *
   * Keyed rather than a field per kind: a kind with nothing thrown is simply
   * absent, so the common case costs no bytes and a fifth reaction needs no change
   * here at all.
   */
  reactions: Partial<Record<ReactionKind, ReactionTally[]>>;
  /** Extra hints bought this match. Each one is a drink they owe the room. */
  drinks: number;
}

/**
 * A room anybody on this server can walk into, as shown on the landing page.
 *
 * Deliberately says nothing about *who* is in it. A headcount answers "is
 * anything happening here?", which is the question being asked; a guest list
 * would tell the whole network who is playing with whom, which is nobody's
 * business and not something anybody opted into by joining a room.
 */
export interface OpenRoom {
  code: string;
  mode: GameMode;
  wordSource: WordSource;
  phase: Phase;
  players: number;
  capacity: number;
  /** False when it is full. Solo rooms are never listed at all. */
  joinable: boolean;
  /** Round in progress, when one is. Lets the list say "round 2 of 5". */
  round: number;
  totalRounds: number;
}

/** Someone with the app open who could be invited into a room. */
export interface OnlinePerson {
  id: string;
  nickname: string;
  /** True when they are already in some room — invite them anyway, or don't. */
  busy: boolean;
}

export interface TeamView {
  id: number;
  name: string;
  memberIds: string[];
  bestRank: number | null;
  guessCount: number;
  solved: boolean;
  place: number | null;
  score: number;
}

export interface Standing {
  key: string;
  label: string;
  score: number;
  detail: string;
}

export interface FeedItem {
  n: number;
  at: number;
  kind:
    | "join"
    | "leave"
    | "solve"
    | "round"
    | "chat"
    | "system"
    | "hint"
    | "buzz"
    | "react"
    /** A move on the Monopoly board. Carries its own glyph in `icon`. */
    | "mono";
  /**
   * The message *without* the name in front of it — "joined", "disconnected".
   *
   * Kept separate from `actor` so the client can colour the name per person.
   * Baking the name into the text would leave the browser matching substrings
   * against nicknames, which breaks the moment someone is called "left".
   */
  text: string;
  /** Display name this line is about, when it is about somebody. */
  actor?: string;
  playerId?: string;
  /**
   * Player ids this line tagged with `@`, resolved by the server.
   *
   * Ids rather than names so the client can tell whether *you* were tagged
   * without matching strings, and so a rename cannot orphan a mention. The names
   * as typed stay in `text`; this is the authoritative list of who it reached.
   */
  mentions?: string[];
  /**
   * Glyph for this line, when the line brought its own.
   *
   * Only the board game sets it: a Monopoly feed is a hundred lines of dice,
   * rent and deals, and the kind-based glyph table cannot tell those apart the
   * way it can tell a join from a solve.
   */
  icon?: string;
}

// ---------------------------------------------------------------------------
// Journeys
//
// One player's path to the word, round by round. Deliberately *not* part of the
// room snapshot: a 24-player, 20-round match holds thousands of guesses, and
// almost nobody is looking at almost all of them. The client asks for one
// player's journey and gets one reply.
// ---------------------------------------------------------------------------

export interface JourneyStep {
  word: string;
  rank: number;
  at: number;
  /** True for rows the board received from a hint rather than a guess. */
  hint?: boolean;
}

export interface JourneyRound {
  number: number;
  /** Null when the round is still running, or when reveal is switched off. */
  secret: string | null;
  solved: boolean;
  place: number | null;
  bestRank: number | null;
  points: number;
  /** Counts stay honest even when `steps` is withheld — they are public anyway. */
  guesses: number;
  hints: number;
  /**
   * True while the round is live and the viewer is not on this board. Seeing a
   * rival's guesses mid-round would hand over their progress, so the steps are
   * withheld until the round ends — never merely hidden in the browser.
   */
  hidden: boolean;
  steps: JourneyStep[];
}

export interface Journey {
  playerId: string;
  nickname: string;
  teamId: number | null;
  /**
   * True when the live round is withheld only because they have not agreed to
   * show it — the viewer can ask. False when there is nothing to ask for
   * (it is already visible) or nothing to show yet.
   */
  needsApproval: boolean;
  rounds: JourneyRound[];
  totals: {
    guesses: number;
    hints: number;
    solves: number;
    bestRank: number | null;
    score: number;
  };
}

export interface RoundView {
  number: number;
  total: number;
  startedAt: number;
  /** Epoch ms deadline, or null when the round is untimed. */
  endsAt: number | null;
  /** Populated only once the round is over and reveal is enabled. */
  secret: string | null;
  /** The secret's emoji, when it has one. Sent with the secret, never before. */
  secretIcon?: string;
  /** Words closest to the secret, revealed at round end for the post-mortem. */
  nearMisses: string[] | null;
}

export interface RoomView {
  code: string;
  phase: Phase;
  config: RoomConfig;
  hostId: string;
  you: {
    id: string;
    nickname: string;
    isHost: boolean;
    teamId: number | null;
    boardId: string | null;
    /**
     * In the room but not in the game — you arrived after the board was dealt.
     *
     * Watching is allowed and playing is not, and the difference is one flag
     * rather than a second kind of connection: everything a spectator sees is
     * something every player can see too.
     */
    spectator: boolean;
    /** Your turns are being played by the machine while this is on. */
    auto: boolean;
  };
  players: PublicPlayer[];
  teams: TeamView[];
  round: RoundView | null;
  board: BoardView | null;
  standings: Standing[];
  feed: FeedItem[];
  /** Server clock at send time, so the client can correct for drift on timers. */
  serverNow: number;
  /** True once the ranker has vectors loaded; the UI warns if it is running on the sample pack. */
  rankerInfo: { vocabSize: number; sample: boolean };
  /**
   * Which word sources this server can actually offer. A source with no usable
   * words (file missing, or none of its words are in the embedding pack) is
   * reported unavailable so the lobby can disable it rather than fail at start.
   */
  wordSources: WordSourceStatus[];
  /**
   * The board game, when this room is playing it. Null for every word mode.
   *
   * Sent whole on every change like the rest of the snapshot. A board is a few KB
   * and Monopoly moves once per turn rather than once per keystroke, so the same
   * "full snapshot, no desync" trade the word game makes is even cheaper here.
   */
  mono: MonopolyView | null;
  /** Boards this server can offer, for the lobby picker. */
  monoMaps: MonoMapSummary[];
}

// ---------------------------------------------------------------------------
// Monopoly
//
// The board is described to the browser rather than known by it: names, icons,
// prices, who owns what and what it would cost to land there all arrive from the
// server. The client draws and nothing more — it never computes rent, never
// decides whose turn it is, and never moves a token on its own.
// ---------------------------------------------------------------------------

/** One row in the lobby's board picker. */
export interface MonoMapSummary {
  id: string;
  name: string;
  icon: string;
  /** "Thủ đô", "Thành phố", "Toàn quốc" — what kind of place this is. */
  region: string;
  note: string;
  /** True for a board the host loaded from a file rather than one we ship. */
  custom?: boolean;
}

export interface MonoGroupView {
  id: string;
  name: string;
  icon: string;
  color: string;
}

/** One of the 40 squares, as it stands right now. */
export interface MonoSpaceView {
  i: number;
  kind: string;
  name: string;
  icon: string;
  note: string;
  /** Which drawing in shared/monopoly_art.js illustrates this square. */
  scene: string;
  /** Colour group, for `place` squares only. */
  group?: string;
  price?: number;
  houseCost?: number;
  /** Tax squares: the flat amount, and the percentage option when there is one. */
  amount?: number;
  percent?: number;
  /** Ownable squares only. */
  ownerId?: string | null;
  /** 0–4 houses, 5 for a hotel. */
  level?: number;
  mortgaged?: boolean;
  /**
   * What landing here would cost right now, computed server-side.
   *
   * Absent when nobody owns it or it is mortgaged. Sent so the browser can show
   * the damage without reimplementing group doubling, station counts and the
   * dice-multiplier rule — three places for the two sides to disagree.
   */
  rent?: number;
  /**
   * Whether the owner could put another building up right now, and why not.
   *
   * Answered by the server for the same reason `rent` is: the rule is the whole
   * colour group *or* standing on the square at the moment the board asks, even
   * build across the part of the group they hold, no mortgages, and enough cash
   * — five things a browser would have to reimplement to grey out one button.
   */
  canBuild?: boolean;
  buildNote?: string;
}

export interface MonoPlayerView {
  id: string;
  /** Their piece. Assigned at kick-off and fixed for the game. */
  token: string;
  /** Seat number, which is turn order. */
  order: number;
  /**
   * Their colour, as a hue on the wheel.
   *
   * Dealt with the seat rather than hashed from the id, because a hash collides
   * and two people in the same room came out the same green. Everything that
   * draws a player — piece, name, deed, pawn — reads this one number.
   */
  hue: number;
  cash: number;
  pos: number;
  inJail: boolean;
  jailTurns: number;
  /** Unspent "ra tù miễn phí" cards. */
  jailCards: number;
  /** Unspent "the next rent is waived" cards, off the Khí vận draw. */
  shields: number;
  bankrupt: boolean;
  /** Cash plus everything on paper. The number the table watches. */
  net: number;
}

/**
 * What the game is waiting for, and who from.
 *
 * Exactly one is live at a time, which is also how turn order is enforced: the
 * server refuses any action that does not answer the open question.
 */
export interface MonoPendingView {
  kind: "roll" | "jail" | "buy" | "upgrade" | "tax" | "debt" | "end" | "over";
  /** Who has to answer. For a debt this is not always the player in turn. */
  playerId: string;
  /** `buy`: the square and its asking price. `upgrade`: the square you are standing on. */
  space?: number;
  price?: number;
  /** `upgrade`: what the next building costs, and the level it would take you to. */
  buildCost?: number;
  level?: number;
  /** `tax`: the two amounts, so the choice can be made on the numbers. */
  flat?: number;
  percentAmount?: number;
  /** `debt`: what is owed and to whom. Null `toId` means the bank. */
  amount?: number;
  toId?: string | null;
  /** `jail`: the fine, cards in hand, and turns served. */
  bail?: number;
  cards?: number;
  turns?: number;
}

/** An open "can we start over?" vote. */
export interface MonoRestartView {
  byId: string;
  /** Seated players who have said yes; the asker counts as one. */
  yesIds: string[];
  /** Seated players who have said no. One no is enough to sink it. */
  noIds: string[];
  /** Everybody whose answer is still wanted. */
  pendingIds: string[];
}

export interface MonoAuctionView {
  space: number;
  high: number;
  highId: string | null;
  /** Everyone who has not folded. Any of them may raise at any time. */
  activeIds: string[];
}

export interface MonoTradeView {
  id: string;
  fromId: string;
  toId: string;
  giveSpaces: number[];
  giveCash: number;
  wantSpaces: number[];
  wantCash: number;
}

/** The card just drawn, held on screen until the turn moves on. */
export interface MonoCardView {
  deck: "chance" | "chest";
  icon: string;
  text: string;
  forId: string;
  /**
   * Which rarity it came out at, for the Khí vận draw.
   *
   * Cơ hội is still the printed pile stepped through in order and has no tier;
   * Khí vận is a lucky draw, and the tier is the whole point of the reveal.
   */
  tier?: string;
  /**
   * How many cards this game has drawn.
   *
   * The browser animates a draw once per draw, and two identical cards in a row
   * are indistinguishable by content — the same reason `rollNo` exists.
   */
  no: number;
}

export interface MonopolyView {
  map: {
    id: string;
    name: string;
    icon: string;
    region: string;
    note: string;
    /** The drawing for the middle of the board: the board's own emblem, shown large. */
    scene: string;
    money: { unit: string; start: number; go: number; bail: number };
    groups: MonoGroupView[];
  };
  spaces: MonoSpaceView[];
  players: MonoPlayerView[];
  /** Whose turn. Null once the game is over. */
  turnId: string | null;
  dice: [number, number] | null;
  /**
   * Throws so far this game. The faces alone cannot tell one throw from the
   * next — 3–4 twice in a row looks identical — so this is what tells the
   * browser a fresh roll happened and the dice should be thrown again.
   */
  rollNo: number;
  /** Consecutive doubles this turn; the third one is jail. */
  doubles: number;
  pending: MonoPendingView;
  auction: MonoAuctionView | null;
  trades: MonoTradeView[];
  card: MonoCardView | null;
  /** Who the board is waiting on, or null when it is waiting on nobody. */
  waitingOn: string | null;
  /** When the question on the table went up, for a visible countdown. */
  waitAt: number;
  /** When the machine will answer it for them. Null when nothing is pending. */
  autoAt: number | null;
  /** Who has handed their turns to the machine, so the table can see it. */
  autoIds: string[];
  /**
   * A request to abandon this game and deal a new one, and who has agreed.
   *
   * On the view rather than the room state because it is a board question: the
   * people who have to agree are the ones sitting at the table.
   */
  restart: MonoRestartView | null;
  /** Money in the middle under the house rule, or null when it is switched off. */
  pot: number | null;
  round: number;
  winnerId: string | null;
  rules: { auction: boolean; parkingPot: boolean; doubleGo: boolean };
}

/**
 * Everything one player can do on the board, as one message.
 *
 * Kept as a single `mono` message with an `a` discriminator rather than fifteen
 * top-level kinds: they all share the same room lookup, the same authority check
 * and the same error handling, and spreading them across the main switch would
 * put fifteen near-identical cases in it.
 */
export type MonoAction =
  | { a: "roll" }
  | { a: "buy" }
  | { a: "decline" }
  | { a: "bid"; amount: number }
  | { a: "withdraw" }
  | { a: "tax"; how: "flat" | "percent" }
  | { a: "jail"; how: "pay" | "card" }
  | { a: "build"; space: number }
  /** Turn down the building the board just offered you, and get on with the turn. */
  | { a: "later" }
  | { a: "sell"; space: number }
  | { a: "mortgage"; space: number }
  | { a: "unmortgage"; space: number }
  | { a: "endTurn" }
  /** "I am still here" — restarts the clock before it plays the turn for you. */
  | { a: "hold" }
  | { a: "bankrupt" }
  | {
    a: "propose";
    toId: string;
    giveSpaces: number[];
    giveCash: number;
    wantSpaces: number[];
    wantCash: number;
  }
  | { a: "respond"; tradeId: string; accept: boolean }
  /** Host: move past somebody whose browser has gone. */
  | { a: "skip" };

export interface WordSourceStatus {
  key: WordSource;
  /** Words in the pool that exist in the embedding pack. */
  size: number;
  available: boolean;
  /** Human-readable reason when unavailable. */
  note: string;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: "create"; nickname: string; config?: Partial<RoomConfig>; playerId?: string }
  | { t: "join"; code: string; nickname: string; playerId?: string }
  | { t: "config"; patch: Partial<RoomConfig> }
  | { t: "team"; teamId: number | null; playerId?: string }
  | { t: "shuffleTeams" }
  | { t: "start" }
  | { t: "guess"; word: string }
  | { t: "hint" }
  /**
   * Ask what a word means, how it is said, and what it is in Vietnamese.
   *
   * Answerable for any word, not only ones on your board: knowing the definition
   * of `banana` reveals nothing about the secret, and a player looking a word up
   * *before* guessing it is the case this feature was asked for.
   */
  | { t: "define"; word: string }
  | { t: "next" }
  | { t: "endRound" }
  /** Host: stop the match here. Scores the round in progress first. */
  | { t: "endMatch" }
  /** Host: clear every score and go back to a fresh lobby. */
  | { t: "reset" }
  /** Ask for one player's journey. Answered only to the asker. */
  | { t: "journey"; playerId: string }
  /** Ask that player for permission to see the round they are still playing. */
  | { t: "journeyRequest"; playerId: string }
  /** Answer somebody's request to watch your round. */
  | { t: "journeyDecide"; playerId: string; approve: boolean }
  /** Buy a hint past the allowance. Costs a round of drinks and says so. */
  | { t: "extraHint" }
  /** Shake everyone else's window. Rate limited, and a no-op when alone. */
  | { t: "buzz" }
  | { t: "react"; playerId: string; kind: ReactionKind }
  /**
   * Announce the name this browser is using, so other people can invite them.
   * Held in the connection only — never written to disk, gone when the tab is.
   */
  | { t: "presence"; nickname: string }
  /** Who else has the app open right now. */
  | { t: "invitable" }
  /** What is open on this server, for the landing page. */
  | { t: "rooms" }
  | { t: "invite"; playerId: string }
  /**
   * Tell somebody they are being lined up for a room that does not exist yet.
   *
   * The one invite-shaped message that is legal *without* a room, which is the
   * whole point of it: ticking a name on the create screen used to make no sound
   * at all on the other end, so somebody waiting to be invited sat watching a
   * landing page for however long the host took to finish choosing settings.
   * `cancel` withdraws it when the tick is undone.
   */
  | { t: "inviteAhead"; playerId: string; cancel?: boolean }
  | { t: "inviteDecline"; playerId: string }
  /** One move on the Monopoly board. */
  | { t: "mono"; action: MonoAction }
  /**
   * Hand your turns to the machine, or take them back.
   *
   * Separate from `mono` because it is not a move: a spectator has no seat to
   * make one from, and it stays legal while somebody else is mid-decision.
   */
  | { t: "monoAuto"; on: boolean }
  /** Ask the table to abandon this game and deal a new one. */
  | { t: "monoRestart" }
  /** Answer somebody else's request to start over. */
  | { t: "monoRestartVote"; agree: boolean }
  /**
   * Host, in the lobby: play this board instead.
   *
   * The file is sent as typed and validated on the server, because the server is
   * the one that has to play on it — a browser that checked it first would only
   * be a second opinion we would have to check again.
   */
  | { t: "monoMap"; map: unknown }
  | { t: "chat"; text: string }
  | { t: "kick"; playerId: string }
  | { t: "promote"; playerId: string }
  | { t: "leave" }
  /**
   * A private message to the per-player assistant. Nothing about it touches room
   * state: it is not broadcast, not stored, and other players never learn it
   * happened. `prefs` is the asker's current appearance, sent as context only so
   * "a bit warmer than that" can mean something; the server never retains it.
   */
  | {
    t: "assist";
    /** Correlates the reply, since the answer can take seconds. */
    id: string;
    text: string;
    prefs?: Record<string, unknown>;
    history?: { role: string; text: string }[];
  }
  | { t: "ping" };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { t: "hello"; playerId: string; code: string }
  | { t: "state"; room: RoomView }
  | {
    t: "guessResult";
    accepted: boolean;
    word: string;
    rank?: number;
    /**
     * Set when the guess was rejected: "unknown" | "duplicate" | "tooFast" |
     * "closed" | "invalid"
     */
    reason?: string;
    message?: string;
  }
  | { t: "clue"; text: string; boardId: string }
  /**
   * Reply to one `define`, sent only to the asker.
   *
   * `status` separates three outcomes a single nullable field would blur, because
   * each one needs different words on screen: we looked and there is no such word,
   * we cannot look at all on this server, and we tried and it broke.
   */
  | {
    t: "definition";
    word: string;
    note?: WordNote;
    status: "ok" | "unknown" | "unavailable" | "failed";
  }
  /** Reply to one `journey` request, sent only to the asker. */
  | { t: "journey"; journey: Journey | null; message?: string }
  /** Somebody would like to watch your round. Only you get this. */
  | { t: "journeyAsk"; playerId: string; nickname: string }
  /** Their answer, back to whoever asked. */
  | { t: "journeyDecision"; playerId: string; nickname: string; approved: boolean }
  /** Somebody buzzed the room. Everyone gets it, the buzzer included. */
  | { t: "buzz"; playerId: string; nickname: string }
  /**
   * Somebody tagged you in the feed. Only the people named get this.
   *
   * The line is already on its way to everybody in the next snapshot — this is
   * purely the nudge, so that being named finds you when you are looking
   * somewhere else.
   */
  | { t: "mentioned"; fromId: string; fromNickname: string }
  /**
   * Somebody threw something. Sent to the whole room so every browser can play
   * the same animation, and carries both ends so each one can decide whether it
   * is watching, on the receiving end, or the one who threw it.
   */
  | {
    t: "reaction";
    kind: ReactionKind;
    fromId: string;
    fromNickname: string;
    toId: string;
    toNickname: string;
    /** How many this thrower has landed on this target this round. */
    count: number;
    /** How many that target has taken from everyone. Drives the escalation. */
    total: number;
  }
  /** Reply to `invitable`, sent only to the asker. */
  | { t: "invitable"; people: OnlinePerson[] }
  /** Reply to `rooms`. `online` counts connected browsers, not room members. */
  | { t: "rooms"; online: number; playing: number; rooms: OpenRoom[] }
  /** You have been invited into a room. */
  | { t: "invited"; fromId: string; fromNickname: string; code: string }
  /**
   * Somebody is building a room with you in mind. No code yet — that arrives as
   * `invited` the moment the room exists, which is usually seconds later.
   */
  | { t: "inviteAhead"; fromId: string; fromNickname: string; cancel?: boolean }
  /**
   * What became of a loaded board, sent only to the host who loaded it.
   *
   * `errors` is every problem found rather than the first one, because a map file
   * is usually wrong in a handful of small ways at once and fixing them one
   * round-trip at a time is miserable.
   */
  | { t: "monoMapResult"; ok: boolean; name?: string; errors: string[]; warnings: string[] }
  | { t: "toast"; level: "info" | "warn" | "error" | "good"; text: string }
  | { t: "kicked"; reason: string }
  /** Another connection took over this player id — usually a second tab. */
  | { t: "superseded"; message: string }
  | { t: "error"; code: string; message: string }
  /**
   * Reply to one `assist`, sent only to the asker. `patch` carries appearance
   * fields the assistant wants changed — already filtered to the allowed set,
   * and re-checked in the browser before anything is applied.
   */
  | {
    t: "assistReply";
    id: string;
    text?: string;
    patch?: Record<string, unknown>;
    /** Set instead of `text` when the call could not be made at all. */
    error?: string;
  }
  | { t: "pong" };
