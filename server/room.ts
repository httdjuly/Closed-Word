// Room state machine: one instance per game room, authoritative for everything.
//
// The unifying idea across all four modes is the *board* — a guess list with its
// own hints, best rank and finish position. Modes differ only in how many boards
// exist and who is attached to each:
//
//   race / rounds  one board per player   (you only see your own guesses)
//   teams          one board per team      (teammates share a board)
//   coop           one board for the room  (everyone shares, against a clock)
//
// Everything downstream — guessing, hints, solving, placement, scoring — is
// written against boards, so adding a *word* mode means deciding board
// membership and nothing else.
//
//   monopoly       no boards at all
//
// The board game is the exception, and it is deliberately a thin one. A monopoly
// room reuses everything this class is actually good at — codes, membership,
// host, reconnects, chat, mentions, the feed — and delegates the game itself to
// MonopolyGame, which knows nothing about rooms. So the guess/hint/round/score
// machinery below is simply not reached in that mode, rather than taught to
// handle a game it was not written for.

import type {
  BoardView,
  FeedItem,
  Guess,
  Journey,
  JourneyRound,
  JourneyStep,
  Phase,
  PublicPlayer,
  ReactionKind,
  ReactionTally,
  RoomConfig,
  RoomView,
  RoundView,
  Standing,
  TeamView,
  WordSource,
  WordSourceStatus,
} from "../shared/protocol.ts";
import type { MonoAction, MonoMapSummary, MonopolyView } from "../shared/protocol.ts";
import type { Ranker } from "./ranker.ts";
import type { IconPicker } from "./wordicon.ts";
import { MAX_MONOPOLY_PLAYERS, MIN_MONOPOLY_PLAYERS, MonopolyGame } from "./monopoly.ts";
import { AUTO_STEP_MS, formatMoney, normaliseMap } from "../shared/monopoly.js";
import { builtinMap, DEFAULT_MAP_ID, mapSummaries } from "../shared/monopoly_maps.js";
import {
  boardScope,
  BUZZ_COOLDOWN_MS,
  coopScore,
  DEFAULT_CONFIG,
  DIFFICULTIES,
  effectiveRoundSeconds,
  effectiveTotalRounds,
  FINISH_KEYS,
  formatRankValue,
  hintTargetRank,
  isBoardMode,
  isSoloMode,
  LIMITS,
  MODES,
  placementPoints,
  REACTION_FEED_MILESTONE,
  REACTION_KEYS,
  REACTION_MAX_PER_SENDER,
  REACTION_WINDOW_MS,
  REACTIONS,
  REACTIONS_PER_WINDOW,
  TEAM_NAMES,
  WORD_SOURCES,
} from "../shared/constants.js";
import { cleanText } from "../shared/text.js";

const FEED_LIMIT = 60;
const NEAR_MISS_COUNT = 10;

/**
 * How much journey history a room keeps, and how much of one round it keeps per
 * player. Both are memory bounds rather than product decisions: a room that is
 * never swept would otherwise hold every guess anyone ever made in it. The
 * *counts* on a journey round are computed before truncation, so a trimmed
 * journey still reports its real length.
 */
const JOURNEY_HISTORY_LIMIT = 20;
const JOURNEY_STEP_LIMIT = 400;

export interface Board {
  id: string;
  label: string;
  /** Player ids attached to this board. */
  members: Set<string>;
  /** Team id for team boards, else null. */
  teamId: number | null;
  guesses: Guess[];
  seen: Set<string>;
  hintsUsed: number;
  /** Guesses spent against the budget. Counted separately because hints are free. */
  spent: number;
  bestRank: number | null;
  solved: boolean;
  solvedAt: number | null;
  place: number | null;
  clue: string | null;
}

/**
 * One player's slice of one finished round, kept so their journey survives the
 * board being torn down at the start of the next round.
 *
 * Stored per player rather than per board so a team can be reshuffled between
 * rounds without rewriting history.
 */
interface JourneyEntry {
  nickname: string;
  teamId: number | null;
  boardId: string;
  solved: boolean;
  place: number | null;
  bestRank: number | null;
  points: number;
  /** True totals, counted before `steps` was trimmed to JOURNEY_STEP_LIMIT. */
  guesses: number;
  hints: number;
  steps: JourneyStep[];
}

interface RoundRecord {
  number: number;
  secret: string;
  entries: Map<string, JourneyEntry>;
}

export interface Player {
  id: string;
  nickname: string;
  teamId: number | null;
  connected: boolean;
  lastSeen: number;
  /** Cumulative match score. */
  score: number;
  /** Reset every round. */
  guessCount: number;
  bestRank: number | null;
  /** Timestamps of recent guesses, for rate limiting. */
  recentGuesses: number[];
  /**
   * Who threw what at them this round, and how many: kind -> sender id -> count.
   * Keyed by *id* rather than name so a rename cannot fork somebody's tally, and
   * so the nicknames shown are always the current ones. Cleared with the round.
   */
  reactions: Map<ReactionKind, Map<string, number>>;
  /** Timestamps of recent throws, for the rate limit. */
  recentReactions: number[];
  /** Hints bought past the allowance this match. One drink apiece. */
  drinks: number;
  /** Last buzz, for the cooldown. */
  lastBuzzAt: number;
  /**
   * Board game: their turns are being played by the machine.
   *
   * Switched on by them ("I'm busy, carry on without me") or by the twenty-second
   * clock running out, and switched off again by their next move — which is the
   * only signal we get that somebody came back.
   */
  autoPlay: boolean;
}

export type GuessOutcome =
  | { accepted: true; word: string; rank: number; solved: boolean }
  | { accepted: false; word: string; reason: string; message: string; rank?: number };

export interface ClueProvider {
  /** Returns a natural-language clue for `secret` that must not contain it. */
  clue(
    secret: string,
    context: { bestRank: number | null; guesses: string[]; wordSource?: WordSource },
  ): Promise<string>;
}

export interface RoomDeps {
  ranker: Ranker;
  clueProvider?: ClueProvider | null;
  /**
   * Picks the emoji shown beside a word. Optional: without it rows simply carry
   * no icon, which is also what happens for most words when it is present.
   */
  icon?: IconPicker;
  /** Called whenever observable state changed and clients need a fresh snapshot. */
  onChange: (room: Room) => void;
  now?: () => number;
}

export class Room {
  readonly code: string;
  config: RoomConfig;
  phase: Phase = "lobby";
  hostId = "";
  round = 0;
  secret: string | null = null;
  roundStartedAt = 0;
  roundEndsAt: number | null = null;
  /** Set once the first board solves, so we can show "everyone else has Xs left". */
  graceStartedAt: number | null = null;

  readonly players = new Map<string, Player>();
  readonly boards = new Map<string, Board>();
  readonly teamScores = new Map<number, number>();
  /** Cumulative co-op score across rounds. */
  coopTotal = 0;

  #usedSecrets = new Set<string>();
  /** Finished rounds, oldest first. Feeds the journey view. */
  #history: RoundRecord[] = [];
  /**
   * Who has agreed to let whom watch their round: target id -> viewer ids.
   * Consent is for the round in progress only and is dropped when it ends, so
   * agreeing once does not sign away every round of the match.
   */
  #journeyGrants = new Map<string, Set<string>>();
  #feed: FeedItem[] = [];
  #feedSeq = 0;
  #guessSeq = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The board's own clock: fires once, when the current wait runs out.
   *
   * A single re-armed timeout rather than a ticking interval, because the board
   * already tells us every time anything changes and the deadline is derived
   * from that. An interval would poll a room where four people are thinking.
   */
  #monoTimer: ReturnType<typeof setTimeout> | null = null;
  /** An open "shall we start over?" vote. */
  #monoRestart: { byId: string; yes: Set<string>; no: Set<string> } | null = null;
  #deps: RoomDeps;
  #lastRound: RoundView | null = null;
  #closed = false;

  /**
   * The board game, once it has started. Null in the lobby and in every word
   * mode — its absence is what the guess path checks, so there is no way to be
   * halfway between the two games.
   */
  mono: MonopolyGame | null = null;
  /**
   * A board the host loaded from a file, kept on the room rather than in the
   * config: the config is patched field by field from the lobby and echoed in
   * every snapshot, and a 40-square board has no business in either.
   */
  // deno-lint-ignore no-explicit-any
  #customMap: any = null;

  constructor(code: string, config: Partial<RoomConfig>, deps: RoomDeps) {
    this.code = code;
    this.config = sanitiseConfig({ ...DEFAULT_CONFIG, ...config });
    this.#deps = deps;
  }

  get ranker(): Ranker {
    return this.#deps.ranker;
  }

  now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  get totalRounds(): number {
    return effectiveTotalRounds(this.config);
  }

  get isEmpty(): boolean {
    return this.players.size === 0;
  }

  get connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  #touch(): void {
    if (!this.#closed) this.#deps.onChange(this);
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /** Add a player, or reattach an existing one (reconnect). Returns the player. */
  join(playerId: string, nickname: string): Player {
    const existing = this.players.get(playerId);
    if (existing) {
      const wasOffline = !existing.connected;
      existing.connected = true;
      existing.lastSeen = this.now();
      const clean = cleanNickname(nickname);
      if (clean && clean !== existing.nickname) {
        existing.nickname = this.#uniqueNickname(clean, existing.id);
      }
      this.#ensureBoardFor(existing);
      // Balance the "disconnected" notice, so the feed does not imply they left.
      if (wasOffline) {
        this.#pushFeed(
          "join",
          this.#inWords("reconnected", "đã kết nối lại"),
          playerId,
          existing.nickname,
        );
      }
      this.#touch();
      return existing;
    }

    // A closed door rather than a hidden one. Somebody practising alone has
    // asked for a room with nobody in it, and a room code is six characters —
    // guessable enough that "nobody knows it" is not a door.
    if (isSoloMode(this.config.mode) && this.players.size > 0) {
      throw new RoomError(
        "solo",
        "That room is somebody's solo practice. Start your own from the home page.",
      );
    }
    if (this.players.size >= LIMITS.maxPlayers) {
      throw new RoomError("full", `Room ${this.code} is full (${LIMITS.maxPlayers} players).`);
    }
    if (isBoardMode(this.config.mode)) {
      // Monopoly deals cash and a piece at kick-off, so a late arrival cannot be
      // given a seat — but they can be given a chair. They watch, they talk, and
      // they are dealt in the moment the table agrees to start over, which is a
      // far better answer than a closed door to somebody holding a room code.
      if (!this.mono && this.players.size >= MAX_MONOPOLY_PLAYERS) {
        throw new RoomError(
          "full",
          `Bàn ${this.code} đã đủ ${MAX_MONOPOLY_PLAYERS} người.`,
        );
      }
    }

    const player: Player = {
      id: playerId,
      nickname: this.#uniqueNickname(cleanNickname(nickname) || "player", playerId),
      teamId: null,
      connected: true,
      lastSeen: this.now(),
      score: 0,
      guessCount: 0,
      bestRank: null,
      recentGuesses: [],
      reactions: new Map(),
      recentReactions: [],
      drinks: 0,
      lastBuzzAt: 0,
      autoPlay: false,
    };
    this.players.set(playerId, player);
    if (!this.hostId) this.hostId = playerId;
    this.#pushFeed("join", this.#inWords("joined", "vào bàn"), playerId, player.nickname);

    // Late joiners get to play the round in progress rather than watch it — with
    // the one exception of a board already dealt, where there is no seat to give
    // them and a word board would be an object from the wrong game.
    if (this.mono) {
      this.#pushFeed(
        "system",
        `${player.nickname} vào xem — sẽ được chia bàn ở trận sau.`,
      );
    } else if (this.phase === "playing") {
      if (boardScope(this.config.mode) === "team") this.#assignTeam(player);
      this.#ensureBoardFor(player);
    } else if (boardScope(this.config.mode) === "team") {
      // Given a team in the lobby too, not just at kick-off. Waiting until the
      // round starts meant the picker showed two empty teams and looked broken,
      // and nobody could see a 2-v-3 in time to do anything about it.
      this.#assignTeam(player);
    }
    this.#touch();
    return player;
  }

  disconnect(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = false;
    player.lastSeen = this.now();
    // In the lobby nobody has invested anything yet, so drop them outright and
    // keep the roster honest. Mid-match we keep their board and score for a
    // reconnect.
    if (this.phase === "lobby") {
      this.players.delete(playerId);
      this.boards.delete(`p:${playerId}`);
      this.#forget(playerId);
      this.#pushFeed("leave", this.#inWords("left", "đã rời bàn"), playerId, player.nickname);
    } else {
      this.#pushFeed(
        "leave",
        this.#inWords("disconnected", "mất kết nối"),
        playerId,
        player.nickname,
      );
    }
    this.#reassignHostIfNeeded();
    // A browser that went is a wait nobody is going to end, so the board's clock
    // is re-armed on the short fuse rather than the twenty-second one.
    this.#armMonoAuto();
    this.#touch();
  }

  remove(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    // Told to the game *before* the roster forgets them, so its own log line can
    // still name who left. Leaving mid-game is a bank bankruptcy: their deeds go
    // back on the market and the turn moves on if it was theirs.
    this.mono?.removePlayer(playerId);
    this.players.delete(playerId);
    const board = this.boards.get(`p:${playerId}`);
    if (board) this.boards.delete(board.id);
    for (const b of this.boards.values()) b.members.delete(playerId);
    this.#forget(playerId);
    this.#pushFeed("leave", this.#inWords("left", "đã rời bàn"), playerId, player.nickname);
    this.#reassignHostIfNeeded();
    // Their departure may have been the last unsolved board. Not a question the
    // board game asks — it settled up in `removePlayer` above.
    if (this.phase === "playing" && !this.mono) this.#maybeEndRound();
    this.#monoRestart?.yes.delete(playerId);
    this.#monoRestart?.no.delete(playerId);
    this.#settleRestart();
    this.#armMonoAuto();
    this.#touch();
  }

  /**
   * Scrub every trace of a departed player from everyone else's state.
   *
   * Their own record goes with them, but their id also sits in other people's
   * reaction sets and in both halves of the consent map. Left behind, those are
   * a slow leak in a long-lived room and would render as reactions from nobody.
   */
  #forget(playerId: string): void {
    this.#journeyGrants.delete(playerId);
    for (const viewers of this.#journeyGrants.values()) viewers.delete(playerId);
    for (const p of this.players.values()) {
      for (const bucket of p.reactions.values()) bucket.delete(playerId);
    }
  }

  #reassignHostIfNeeded(): void {
    const host = this.players.get(this.hostId);
    if (host?.connected) return;
    const next = [...this.players.values()].find((p) => p.connected) ??
      [...this.players.values()][0];
    if (next && next.id !== this.hostId) {
      this.hostId = next.id;
      this.#pushFeed(
        "system",
        this.#inWords("is now the host", "làm chủ bàn"),
        next.id,
        next.nickname,
      );
    }
  }

  promote(actorId: string, playerId: string): void {
    this.#requireHost(actorId);
    const target = this.players.get(playerId);
    if (!target) throw new RoomError("noPlayer", "That player is not in the room.");
    this.hostId = playerId;
    this.#pushFeed(
      "system",
      this.#inWords("is now the host", "làm chủ bàn"),
      target.id,
      target.nickname,
    );
    this.#touch();
  }

  #uniqueNickname(base: string, ownerId: string): string {
    const taken = new Set(
      [...this.players.values()].filter((p) => p.id !== ownerId).map((p) => p.nickname),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base} ${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base} ${ownerId.slice(0, 4)}`;
  }

  // -------------------------------------------------------------------------
  // Configuration and teams
  // -------------------------------------------------------------------------

  setConfig(actorId: string, patch: Partial<RoomConfig>): void {
    this.#requireHost(actorId);
    if (this.phase === "playing") {
      throw new RoomError("locked", "Settings are locked while a round is running.");
    }
    const next = sanitiseConfig({ ...this.config, ...patch });
    // Switching a populated room to practice would have to throw everybody out
    // to mean anything, which is not a setting change — it is an eviction.
    if (isSoloMode(next.mode) && !isSoloMode(this.config.mode) && this.players.size > 1) {
      throw new RoomError(
        "notAlone",
        "Solo practice is for one. Everybody else would have to leave first.",
      );
    }
    const modeChanged = next.mode !== this.config.mode;
    const teamsChanged = next.teamCount !== this.config.teamCount;
    this.config = next;
    if (modeChanged || teamsChanged) {
      // Team assignments are meaningless outside team mode, and stale team ids
      // break balancing when the team count shrinks.
      for (const p of this.players.values()) p.teamId = null;
      // Turning teams on hands out a balanced starting split straight away, so
      // the lobby always shows a real line-up somebody can argue with.
      if (boardScope(next.mode) === "team") {
        for (const p of this.players.values()) this.#assignTeam(p);
      }
    }
    this.#touch();
  }

  setTeam(actorId: string, targetId: string, teamId: number | null): void {
    const target = this.players.get(targetId);
    if (!target) throw new RoomError("noPlayer", "That player is not in the room.");
    if (actorId !== targetId) this.#requireHost(actorId);
    if (this.phase === "playing") {
      throw new RoomError("locked", "Teams are locked while a round is running.");
    }
    if (teamId !== null && (teamId < 0 || teamId >= this.config.teamCount)) {
      throw new RoomError("badTeam", "No such team.");
    }
    if (target.teamId === teamId) return;
    target.teamId = teamId;
    // Announced, because who is on which side is the room's business — and
    // because a silent move looks like a bug to whoever was moved.
    if (teamId !== null) {
      this.#pushFeed(
        "system",
        actorId === targetId
          ? `${target.nickname} moved to ${teamName(teamId)}`
          : `${target.nickname} was moved to ${teamName(teamId)}`,
      );
    }
    this.#touch();
  }

  shuffleTeams(actorId: string): void {
    this.#requireHost(actorId);
    if (this.phase === "playing") {
      throw new RoomError("locked", "Teams are locked while a round is running.");
    }
    const ids = [...this.players.keys()];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    ids.forEach((id, i) => {
      const p = this.players.get(id);
      if (p) p.teamId = i % this.config.teamCount;
    });
    this.#pushFeed("system", "Teams shuffled");
    this.#touch();
  }

  /** Put a player on the smallest team. */
  #assignTeam(player: Player): void {
    if (player.teamId !== null && player.teamId < this.config.teamCount) return;
    const counts = new Array(this.config.teamCount).fill(0);
    for (const p of this.players.values()) {
      if (p.id !== player.id && p.teamId !== null && p.teamId < counts.length) counts[p.teamId]++;
    }
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
    player.teamId = best;
  }

  // -------------------------------------------------------------------------
  // Round lifecycle
  // -------------------------------------------------------------------------

  start(actorId: string): void {
    this.#requireHost(actorId);
    if (this.phase === "playing") throw new RoomError("running", "A round is already running.");
    if (this.players.size === 0) throw new RoomError("empty", "Nobody is in the room.");
    if (isBoardMode(this.config.mode)) {
      this.#startMonopoly();
      return;
    }
    // Fail in the lobby, where the host can still change the setting, rather
    // than half way through starting a round.
    if (!this.ranker.hasPool(this.config.wordSource)) {
      const name = WORD_SOURCES[this.config.wordSource]?.label ?? this.config.wordSource;
      throw new RoomError(
        "noWords",
        `${name} has no playable words on this server. Pick a different word source.`,
      );
    }
    this.#clearScores();
    this.#pushFeed("system", `Match started — ${this.config.mode}, ${this.totalRounds} round(s)`);
    this.#startRound();
  }

  /**
   * Host: stop the match where it stands.
   *
   * A round in progress is ended properly first rather than discarded, so the
   * points people earned before the host called it still count. Without that,
   * "stop the game" would quietly erase the round everyone just played.
   */
  endMatch(actorId: string): void {
    this.#requireHost(actorId);
    if (this.phase === "lobby") throw new RoomError("closed", "No match is running.");
    if (this.mono) {
      // Monopoly properly ends when one player is left standing, which can take
      // an hour. Calling time instead awards it on net worth, so a room that has
      // to stop still gets a result rather than an abandoned board.
      this.mono.callTime();
      this.phase = "matchEnd";
      this.#clearTimer();
      this.#touch();
      return;
    }
    if (this.phase === "playing") this.endRound();
    if (this.phase !== "matchEnd") {
      this.phase = "matchEnd";
      this.#pushFeed("system", "The host called the match here");
    }
    this.#clearTimer();
    this.#touch();
  }

  /**
   * Host: wipe the slate. Scores, history and used secrets all go, so the next
   * match can draw the same words again and nobody carries a lead into it.
   */
  reset(actorId: string): void {
    this.#requireHost(actorId);
    this.#clearScores();
    this.#history.length = 0;
    this.#toLobby("The host reset the room — scores cleared");
  }

  #clearScores(): void {
    this.round = 0;
    this.coopTotal = 0;
    this.teamScores.clear();
    this.#usedSecrets.clear();
    this.#journeyGrants.clear();
    for (const p of this.players.values()) {
      p.score = 0;
      p.guessCount = 0;
      p.bestRank = null;
      p.recentGuesses = [];
      p.reactions.clear();
      p.recentReactions = [];
      // The bar tab is a match-long joke, so it clears with the scores rather
      // than with the round.
      p.drinks = 0;
    }
  }

  // -------------------------------------------------------------------------
  // The board game
  //
  // Everything above this line is the word game and is not reached in monopoly
  // mode. Everything here delegates: the room owns membership and the feed, and
  // MonopolyGame owns the rules.
  // -------------------------------------------------------------------------

  /** The board this room would play on right now. */
  // deno-lint-ignore no-explicit-any
  monoMap(): any {
    if (this.config.monoMap === "custom" && this.#customMap) return this.#customMap;
    return builtinMap(this.config.monoMap);
  }

  /** The picker's rows: what ships, plus the loaded one when there is one. */
  monoMapSummaries(): MonoMapSummary[] {
    const out: MonoMapSummary[] = mapSummaries();
    if (this.#customMap) {
      out.push({
        id: "custom",
        name: this.#customMap.name,
        icon: this.#customMap.icon,
        region: this.#customMap.region || "Tự tải lên",
        note: this.#customMap.note,
        custom: true,
      });
    }
    return out;
  }

  /**
   * Host, in the lobby: play on a board from a file.
   *
   * Refused mid-game for the obvious reason, and validated here rather than in
   * the browser because this is the copy that gets played on. Returns the
   * problems instead of throwing them: a map file is usually wrong in several
   * small ways at once, and one error per round-trip is a miserable way to fix
   * a list of street names.
   */
  loadMonoMap(
    actorId: string,
    raw: unknown,
  ): { ok: boolean; name?: string; errors: string[]; warnings: string[] } {
    this.#requireHost(actorId);
    if (!isBoardMode(this.config.mode)) {
      return { ok: false, errors: ["Phòng này không chơi cờ tỷ phú."], warnings: [] };
    }
    if (this.mono) {
      return { ok: false, errors: ["Trận đang chạy — không đổi bàn giữa trận."], warnings: [] };
    }

    const result = normaliseMap(raw);
    if (!result.ok || !result.map) {
      return { ok: false, errors: result.errors, warnings: result.warnings };
    }

    this.#customMap = result.map;
    this.config.monoMap = "custom";
    this.#pushFeed(
      "mono",
      `Chủ phòng đã tải bàn "${result.map.name}" (${result.map.spaces.length} ô).`,
      undefined,
      undefined,
      undefined,
      result.map.icon,
    );
    this.#touch();
    return { ok: true, name: result.map.name, errors: [], warnings: result.warnings };
  }

  #startMonopoly(): void {
    // Everybody in the room, which on a restart is the people who were playing
    // plus whoever has been watching since.
    const ids = [...this.players.keys()];
    if (ids.length < MIN_MONOPOLY_PLAYERS) {
      throw new RoomError(
        "tooFew",
        `Cờ tỷ phú cần ít nhất ${MIN_MONOPOLY_PLAYERS} người. Hiện có ${ids.length}.`,
      );
    }
    if (ids.length > MAX_MONOPOLY_PLAYERS) {
      throw new RoomError(
        "tooMany",
        `Cờ tỷ phú chỉ chơi được tối đa ${MAX_MONOPOLY_PLAYERS} người.`,
      );
    }
    this.#clearScores();
    this.#monoRestart = null;
    for (const p of this.players.values()) p.autoPlay = false;
    this.round = 1;
    this.phase = "playing";
    this.roundStartedAt = this.now();
    this.roundEndsAt = null;
    this.mono = new MonopolyGame(
      this.monoMap(),
      ids,
      {
        auction: this.config.monoAuction,
        parkingPot: this.config.monoParkingPot,
        doubleGo: this.config.monoDoubleGo,
      },
      {
        nameOf: (id) => this.players.get(id)?.nickname ?? "",
        connected: (id) => this.players.get(id)?.connected ?? false,
        say: (icon, text, playerId) =>
          this.#pushFeed("mono", text, playerId, undefined, undefined, icon),
        onChange: () => {
          // A finished game moves the room to its end screen, so the host gets
          // the same "play again" affordance as at the end of a word match.
          if (this.mono?.isOver && this.phase === "playing") this.phase = "matchEnd";
          // Every move re-arms the clock, so the deadline the browsers count
          // down to is always the current one.
          this.#armMonoAuto();
          this.#touch();
        },
        // The board reads the room's clock, not the wall's. Two clocks would put
        // the wait deadline on one and the timer that fires it on the other, and
        // a test with a fixed `now` would arm a timeout decades out.
        now: () => this.now(),
      },
    );
    this.#armMonoAuto();
    this.#touch();
  }

  /**
   * One move on the board.
   *
   * A flat dispatch rather than fifteen methods on this class: every branch is a
   * one-line delegation, and the authority checks that matter all live in
   * MonopolyGame where the turn state is.
   */
  monoAction(playerId: string, action: MonoAction): void {
    const game = this.mono;
    if (!game) throw new RoomError("noGame", "Chưa có trận cờ tỷ phú nào đang chạy.");
    const player = this.players.get(playerId);
    if (!player) throw new RoomError("notHere", "Bạn không ở trong phòng này.");
    if (!game.hasSeat(playerId)) {
      throw new RoomError(
        "watching",
        "Bạn đang xem trận này — đề nghị chơi lại thì trận sau bạn được chia bàn.",
      );
    }
    // A move is the only reliable sign that somebody came back to their keyboard,
    // so it is what switches auto off again. Done before the move rather than
    // after, so a move that throws still counts as them being present.
    if (player.autoPlay) this.monoAuto(playerId, false);

    switch (action.a) {
      case "roll":
        game.roll(playerId);
        return;
      case "buy":
        game.buy(playerId);
        return;
      case "decline":
        game.decline(playerId);
        return;
      case "bid":
        game.bid(playerId, Number(action.amount));
        return;
      case "withdraw":
        game.withdrawBid(playerId);
        return;
      case "tax":
        game.payTax(playerId, action.how === "percent" ? "percent" : "flat");
        return;
      case "jail":
        game.leaveJail(playerId, action.how === "card" ? "card" : "pay");
        return;
      case "build":
        game.build(playerId, Number(action.space));
        return;
      case "later":
        game.later(playerId);
        return;
      case "sell":
        game.sellBuilding(playerId, Number(action.space));
        return;
      case "mortgage":
        game.mortgage(playerId, Number(action.space));
        return;
      case "unmortgage":
        game.unmortgage(playerId, Number(action.space));
        return;
      case "endTurn":
        game.endTurn(playerId);
        return;
      case "hold":
        game.hold(playerId);
        return;
      case "bankrupt":
        game.declareBankrupt(playerId);
        return;
      case "propose":
        game.propose(playerId, String(action.toId), {
          giveSpaces: action.giveSpaces,
          giveCash: Number(action.giveCash),
          wantSpaces: action.wantSpaces,
          wantCash: Number(action.wantCash),
        });
        return;
      case "respond":
        game.respond(playerId, String(action.tradeId), Boolean(action.accept));
        return;
      case "skip":
        game.skip(playerId, this.hostId);
        return;
      default:
        throw new RoomError("badAction", "Nước đi không hợp lệ.");
    }
  }

  monoView(): MonopolyView | null {
    if (!this.mono) return null;
    const view = this.mono.view();
    // Filled in here rather than in the game, which knows the rules but has no
    // idea who is sitting at their keyboard.
    view.autoIds = [...this.players.values()].filter((p) => p.autoPlay).map((p) => p.id);
    const vote = this.#monoRestart;
    if (vote) {
      const seated = this.mono.seatIds().filter((id) => this.players.has(id));
      view.restart = {
        byId: vote.byId,
        yesIds: seated.filter((id) => vote.yes.has(id)),
        noIds: seated.filter((id) => vote.no.has(id)),
        pendingIds: seated.filter((id) => !vote.yes.has(id) && !vote.no.has(id)),
      };
    }
    return view;
  }

  /** In the room, watching, with no seat at the table. */
  isSpectator(playerId: string): boolean {
    const game = this.mono;
    return game !== null && !game.hasSeat(playerId);
  }

  // -------------------------------------------------------------------------
  // Playing for somebody who is not there
  // -------------------------------------------------------------------------

  /**
   * Hand your turns to the machine, or take them back.
   *
   * Allowed from a spectator too — harmless, and it means the setting survives
   * being dealt in at the start of the next game rather than needing to be found
   * again at the exact moment it matters.
   */
  monoAuto(playerId: string, on: boolean): void {
    const player = this.players.get(playerId);
    if (!player) throw new RoomError("notHere", "Bạn không ở trong phòng này.");
    if (player.autoPlay === on) return;
    player.autoPlay = on;
    this.#pushFeed(
      "system",
      on
        ? `${player.nickname} bật tự động chơi — bàn không phải chờ.`
        : `${player.nickname} đã quay lại, tự chơi tiếp.`,
      playerId,
      player.nickname,
      undefined,
      on ? "🤖" : "🙋",
    );
    this.#armMonoAuto();
    this.#touch();
  }

  /**
   * Arm the board's clock for whatever it is waiting on now.
   *
   * Called from the game's own change hook, so every move re-arms it and the
   * deadline is always the current one. Three cases: somebody on auto gets a
   * short pause, so a run of machine moves is watchable rather than instant; a
   * player whose browser has gone gets the same, because nobody is coming back
   * to that keyboard this turn; anybody else gets the full wait, after which the
   * box is ticked for them and the move is made.
   *
   * The board waits on one person at a time except in an auction, which waits on
   * every bidder still in it. One timer covers that too: it answers for one of
   * them, the move re-arms it, and the next is picked from whoever is left.
   */
  #armMonoAuto(): void {
    if (this.#monoTimer !== null) {
      clearTimeout(this.#monoTimer);
      this.#monoTimer = null;
    }
    const game = this.mono;
    if (!game || this.#closed || this.phase !== "playing") return;
    const waiting = game.waitingIds();
    const deadline = game.autoDeadline();
    if (waiting.length === 0 || deadline === null) return;
    const machine = (id: string) => {
      const player = this.players.get(id);
      return !player || player.autoPlay || !player.connected;
    };
    // Whoever is already a machine goes first and goes soon — there is nothing
    // to wait for there — and anybody who might still be reading the screen
    // keeps the whole fuse.
    const target = waiting.find(machine) ?? waiting[0];
    const at = machine(target) ? this.now() + AUTO_STEP_MS : deadline;
    const handle = setTimeout(() => {
      this.#monoTimer = null;
      this.#fireMonoAuto(target);
    }, Math.max(0, at - this.now()));
    this.#monoTimer = handle;
    // Unreferenced, so a room left mid-game at the end of a test run or at
    // shutdown is not a reason for the process to stay alive.
    Deno.unrefTimer(handle as unknown as number);
  }

  #fireMonoAuto(playerId: string): void {
    const game = this.mono;
    if (!game || this.phase !== "playing") return;
    if (!game.waitingIds().includes(playerId)) {
      this.#armMonoAuto();
      return;
    }
    const player = this.players.get(playerId);
    if (player && !player.autoPlay) {
      // The clock ran out on somebody who is still connected. Tick the box for
      // them and say so, once, so the move that follows does not read as the
      // board playing itself for no reason.
      player.autoPlay = true;
      this.#pushFeed(
        "system",
        `${player.nickname} chưa phản hồi — bàn tự chơi giúp tới khi họ quay lại.`,
        playerId,
        player.nickname,
        undefined,
        "🤖",
      );
    }
    try {
      if (!game.autoMove(playerId)) return;
    } catch (err) {
      // A move the machine believed was legal and was not. Recorded rather than
      // thrown: there is no request here to fail, and the alternative is a room
      // whose clock has quietly stopped.
      this.#pushFeed(
        "system",
        `Không tự chơi giúp được: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        undefined,
        undefined,
        "⚠️",
      );
    }
    this.#touch();
  }

  // -------------------------------------------------------------------------
  // Starting over, by agreement
  // -------------------------------------------------------------------------

  /**
   * Ask the table to abandon this game and deal a new one.
   *
   * A vote rather than a host button, because an hour of four people's afternoon
   * is on that board and the host is not the only one who put it there. One no
   * sinks it; every seated player still in the room has to say yes.
   */
  monoRestartAsk(playerId: string): void {
    const game = this.mono;
    if (!game) throw new RoomError("noGame", "Chưa có trận nào đang chạy.");
    const player = this.players.get(playerId);
    if (!player) throw new RoomError("notHere", "Bạn không ở trong phòng này.");
    if (this.#monoRestart) throw new RoomError("open", "Đã có một đề nghị chơi lại đang mở.");
    // A spectator may ask — they are the people most likely to want to — but has
    // no vote, having nothing on the board to lose.
    const yes = new Set<string>();
    if (game.hasSeat(playerId)) yes.add(playerId);
    this.#monoRestart = { byId: playerId, yes, no: new Set() };
    this.#pushFeed(
      "system",
      `${player.nickname} đề nghị kết thúc trận này và chia bàn mới — cần cả bàn đồng ý.`,
      playerId,
      player.nickname,
      undefined,
      "🔁",
    );
    this.#settleRestart();
    this.#touch();
  }

  monoRestartVote(playerId: string, agree: boolean): void {
    const game = this.mono;
    const vote = this.#monoRestart;
    if (!game || !vote) throw new RoomError("noVote", "Không có đề nghị nào đang mở.");
    const player = this.players.get(playerId);
    if (!player) throw new RoomError("notHere", "Bạn không ở trong phòng này.");
    if (!game.hasSeat(playerId)) {
      throw new RoomError(
        "watching",
        "Người xem không có phiếu — bạn sẽ được chia bàn ở trận sau.",
      );
    }
    vote.yes.delete(playerId);
    vote.no.delete(playerId);
    (agree ? vote.yes : vote.no).add(playerId);
    this.#pushFeed(
      "system",
      agree ? `${player.nickname} đồng ý chơi lại.` : `${player.nickname} muốn chơi tiếp trận này.`,
      playerId,
      player.nickname,
      undefined,
      agree ? "👍" : "👎",
    );
    this.#settleRestart();
    this.#touch();
  }

  /** Carried, sunk, or still waiting on somebody. */
  #settleRestart(): void {
    const game = this.mono;
    const vote = this.#monoRestart;
    if (!game || !vote) return;
    // Only people still here and still in the game get a say. Somebody who
    // walked out cannot hold a vote open for ever.
    const seated = game.seatIds().filter((id) => this.players.has(id));
    if (seated.some((id) => vote.no.has(id))) {
      this.#monoRestart = null;
      this.#pushFeed(
        "system",
        "Không chơi lại — trận này tiếp tục.",
        undefined,
        undefined,
        undefined,
        "▶️",
      );
      return;
    }
    if (!seated.every((id) => vote.yes.has(id))) return;
    this.#monoRestart = null;
    this.#pushFeed(
      "system",
      "Cả bàn đồng ý — chia bàn mới.",
      undefined,
      undefined,
      undefined,
      "🔁",
    );
    // Everybody in the room, spectators included: being dealt in is the whole
    // reason somebody who arrived late asked for this.
    this.#startMonopoly();
  }

  /** Host advancing from the round-end screen. */
  next(actorId: string): void {
    this.#requireHost(actorId);
    if (this.phase === "playing") throw new RoomError("running", "Finish the round first.");
    if (this.phase === "lobby") {
      this.start(actorId);
      return;
    }
    if (this.phase === "matchEnd") {
      this.#toLobby();
      return;
    }
    if (this.round >= this.totalRounds) {
      this.phase = "matchEnd";
      this.#pushFeed("system", "Match over");
      this.#clearTimer();
      this.#touch();
      return;
    }
    this.#startRound();
  }

  #toLobby(note?: string): void {
    note ??= this.#inWords("Back to the lobby", "Về bàn chờ");
    this.phase = "lobby";
    this.round = 0;
    this.secret = null;
    // The board goes with the game. A loaded map stays, because that was a
    // setting the host chose and not part of the game just played.
    this.mono = null;
    this.#monoRestart = null;
    if (this.#monoTimer !== null) {
      clearTimeout(this.#monoTimer);
      this.#monoTimer = null;
    }
    this.boards.clear();
    this.roundEndsAt = null;
    this.graceStartedAt = null;
    this.#lastRound = null;
    this.#clearTimer();
    this.#pushFeed("system", note);
    this.#touch();
  }

  #startRound(): void {
    const difficulty = this.config.difficulty as keyof typeof DIFFICULTIES;
    this.secret = this.ranker.pickSecret(difficulty, this.#usedSecrets, this.config.wordSource);
    this.#usedSecrets.add(this.secret);
    // Building the rank table here (rather than on first guess) keeps the very
    // first guess of a round as fast as every other one.
    this.ranker.table(this.secret);

    this.round++;
    this.phase = "playing";
    this.roundStartedAt = this.now();
    this.graceStartedAt = null;
    this.#lastRound = null;

    const seconds = effectiveRoundSeconds(this.config);
    this.roundEndsAt = seconds > 0 ? this.roundStartedAt + seconds * 1000 : null;

    // Everything that is about *this* round dies with the last one. Reactions,
    // locks and viewing consent are all per-round by design, and clearing them
    // here is also what stops a long match accumulating them.
    this.#journeyGrants.clear();
    for (const p of this.players.values()) {
      p.guessCount = 0;
      p.bestRank = null;
      p.recentGuesses = [];
      p.reactions.clear();
      p.recentReactions = [];
    }

    this.#rebuildBoards();
    this.#pushFeed("round", `Round ${this.round} of ${this.totalRounds} — go!`);
    this.#scheduleTimer();
    this.#touch();
  }

  #rebuildBoards(): void {
    this.boards.clear();
    const scope = boardScope(this.config.mode);
    // The board game has no guess boards. Returning here rather than letting it
    // fall through to the per-player branch, which would build 24 boards nothing
    // ever reads.
    if (scope === "none") return;

    if (scope === "all") {
      this.boards.set("all", makeBoard("all", "Room", null));
      const board = this.boards.get("all")!;
      for (const p of this.players.keys()) board.members.add(p);
      return;
    }

    if (scope === "team") {
      for (const p of this.players.values()) this.#assignTeam(p);
      const used = new Set<number>();
      for (const p of this.players.values()) if (p.teamId !== null) used.add(p.teamId);
      // Only create boards for teams that actually have players, otherwise an
      // empty team would never solve and would hold the round open.
      for (const teamId of [...used].sort((a, b) => a - b)) {
        const board = makeBoard(`t:${teamId}`, teamName(teamId), teamId);
        for (const p of this.players.values()) if (p.teamId === teamId) board.members.add(p.id);
        this.boards.set(board.id, board);
      }
      return;
    }

    for (const p of this.players.values()) {
      const board = makeBoard(`p:${p.id}`, p.nickname, null);
      board.members.add(p.id);
      this.boards.set(board.id, board);
    }
  }

  /** Make sure a late joiner or reconnecting player has a board mid-round. */
  #ensureBoardFor(player: Player): void {
    if (this.phase !== "playing") return;
    const scope = boardScope(this.config.mode);
    if (scope === "all") {
      this.boards.get("all")?.members.add(player.id);
      return;
    }
    if (scope === "team") {
      this.#assignTeam(player);
      const id = `t:${player.teamId}`;
      let board = this.boards.get(id);
      if (!board) {
        board = makeBoard(id, teamName(player.teamId!), player.teamId!);
        this.boards.set(id, board);
      }
      board.members.add(player.id);
      return;
    }
    const id = `p:${player.id}`;
    if (!this.boards.has(id)) {
      const board = makeBoard(id, player.nickname, null);
      board.members.add(player.id);
      this.boards.set(id, board);
    }
  }

  boardFor(playerId: string): Board | null {
    const scope = boardScope(this.config.mode);
    if (scope === "all") return this.boards.get("all") ?? null;
    if (scope === "team") {
      const player = this.players.get(playerId);
      if (!player || player.teamId === null) return null;
      return this.boards.get(`t:${player.teamId}`) ?? null;
    }
    return this.boards.get(`p:${playerId}`) ?? null;
  }

  endRound(actorId?: string): void {
    if (actorId) this.#requireHost(actorId);
    if (this.phase !== "playing") return;
    this.#clearTimer();
    this.phase = "roundEnd";

    const secret = this.secret!;
    const boardCount = this.boards.size;
    const elapsedSeconds = Math.round((this.now() - this.roundStartedAt) / 1000);
    // Snapshot before scoring so each player's journey can record what this
    // round was worth to them, rather than only the running total.
    const scoreBefore = new Map<string, number>();
    for (const p of this.players.values()) scoreBefore.set(p.id, p.score);

    if (this.config.mode === "coop") {
      const board = this.boards.get("all");
      // Scored on the same count the room is shown, so the arithmetic in the
      // feed line always adds up from the numbers next to it.
      const spent = board ? guessesMade(board) : 0;
      const score = board?.solved ? coopScore(spent, elapsedSeconds) : 0;
      this.coopTotal += score;
      this.#pushFeed(
        "round",
        board?.solved
          ? `Round ${this.round}: solved in ${spent} guesses, ` +
            `${elapsedSeconds}s — ${score} points`
          : `Round ${this.round}: time up, the word was "${secret}"`,
      );
    } else {
      for (const board of this.boards.values()) {
        if (!board.solved || board.place === null) continue;
        const points = placementPoints(board.place, boardCount);
        if (board.teamId !== null) {
          this.teamScores.set(board.teamId, (this.teamScores.get(board.teamId) ?? 0) + points);
        }
        for (const memberId of board.members) {
          const p = this.players.get(memberId);
          if (p) p.score += points;
        }
      }
      const solved = [...this.boards.values()].filter((b) => b.solved).length;
      this.#pushFeed(
        "round",
        `Round ${this.round} over — the word was "${secret}" ` +
          `(${solved}/${boardCount} found it)`,
      );
    }

    this.#recordJourneys(secret, scoreBefore);

    this.#lastRound = {
      number: this.round,
      total: this.totalRounds,
      startedAt: this.roundStartedAt,
      endsAt: this.roundEndsAt,
      secret: this.config.revealOnEnd ? secret : null,
      // Only alongside the revealed word. An icon on its own is a clue, and a
      // clue nobody asked for is a leak.
      secretIcon: this.config.revealOnEnd ? this.#deps.icon?.(secret) ?? undefined : undefined,
      nearMisses: this.config.revealOnEnd ? this.ranker.nearest(secret, NEAR_MISS_COUNT) : null,
    };

    if (this.round >= this.totalRounds) {
      this.phase = "matchEnd";
      this.#pushFeed("system", "Match over");
    }
    this.#touch();
  }

  #maybeEndRound(): void {
    if (this.phase !== "playing") return;
    if (this.boards.size === 0) return;
    // A board out of budget can never solve, so waiting on it would hang the
    // round forever — it counts as finished, just not successfully.
    const allDone = [...this.boards.values()].every((b) => b.solved || this.#outOfBudget(b));
    if (allDone) this.endRound();
  }

  // -------------------------------------------------------------------------
  // Guessing
  // -------------------------------------------------------------------------

  guess(playerId: string, rawWord: string): GuessOutcome {
    const player = this.players.get(playerId);
    if (!player) {
      return {
        accepted: false,
        word: rawWord,
        reason: "noPlayer",
        message: "You are not in this room.",
      };
    }
    if (isBoardMode(this.config.mode)) {
      // Reachable only from a stale tab: the board game has no guess box. Named
      // rather than folded into "no round is running", which would read as a
      // timing problem the player could wait out.
      return {
        accepted: false,
        word: rawWord,
        reason: "closed",
        message: "Phòng này đang chơi cờ tỷ phú, không đoán từ.",
      };
    }
    if (this.phase !== "playing" || !this.secret) {
      return { accepted: false, word: rawWord, reason: "closed", message: "No round is running." };
    }

    const word = rawWord.trim().toLowerCase();
    // Digits are allowed so that terms like 2fa and k8s can be typed at all; a
    // letter is still required, so "42" is rejected on shape rather than being
    // told it is not in the word list.
    if (
      !/^[a-z0-9]{2,}$/.test(word) || !/[a-z]/.test(word) ||
      word.length > LIMITS.maxGuessLength
    ) {
      return {
        accepted: false,
        word,
        reason: "invalid",
        message: "Guesses are single words — letters, or letters with digits like k8s.",
      };
    }

    const board = this.boardFor(playerId);
    if (!board) {
      return { accepted: false, word, reason: "closed", message: "You have no board this round." };
    }
    if (board.solved) {
      return { accepted: false, word, reason: "closed", message: "This board already found it." };
    }
    if (board.guesses.length >= LIMITS.maxGuessesPerBoard) {
      return { accepted: false, word, reason: "closed", message: "Guess limit reached." };
    }
    if (this.#outOfBudget(board)) {
      return {
        accepted: false,
        word,
        reason: "closed",
        message: `Guess budget spent — ${this.config.guessLimit} per board this round.`,
      };
    }

    const now = this.now();
    player.recentGuesses = player.recentGuesses.filter((t) => now - t < LIMITS.guessWindowMs);
    if (player.recentGuesses.length >= LIMITS.guessesPerWindow) {
      return { accepted: false, word, reason: "tooFast", message: "Slow down a moment." };
    }

    if (board.seen.has(word)) {
      const rank = this.ranker.rank(this.secret, word) ?? undefined;
      return { accepted: false, word, reason: "duplicate", message: "Already guessed.", rank };
    }

    const rank = this.ranker.rank(this.secret, word);
    if (rank === null) {
      return {
        accepted: false,
        word,
        reason: "unknown",
        message: `"${word}" is not in the word list.`,
      };
    }

    player.recentGuesses.push(now);
    player.guessCount++;
    board.spent++;
    if (player.bestRank === null || rank < player.bestRank) player.bestRank = rank;

    this.#addRow(board, {
      n: ++this.#guessSeq,
      word,
      rank,
      byPlayerId: playerId,
      byNickname: player.nickname,
      at: now,
    });

    const solved = rank === 1;
    if (solved) {
      this.#markSolved(board, player);
    } else if (this.#outOfBudget(board)) {
      // Announce it, because from the board's side "budget spent" and "the round
      // is just quiet" look identical until you try to type.
      this.#pushFeed("system", "is out of guesses", playerId, board.label);
      this.#maybeEndRound();
    }
    this.#touch();
    return { accepted: true, word, rank, solved };
  }

  /** A board that has spent its budget is done for the round, solved or not. */
  #outOfBudget(board: Board): boolean {
    return this.config.guessLimit > 0 && board.spent >= this.config.guessLimit;
  }

  /**
   * Put a word on a board.
   *
   * The single choke point for both guesses and hint reveals, which is why the
   * icon is attached here: one call site means a hint row can never look
   * different from a guessed one.
   */
  #addRow(board: Board, row: Guess): void {
    const icon = this.#deps.icon?.(row.word);
    if (icon) row.icon = icon;
    board.guesses.push(row);
    board.seen.add(row.word);
    if (board.bestRank === null || row.rank < board.bestRank) board.bestRank = row.rank;
  }

  #markSolved(board: Board, solver: Player): void {
    board.solved = true;
    board.solvedAt = this.now();
    const alreadyDone =
      [...this.boards.values()].filter((b) => b.solved && b.id !== board.id).length;
    board.place = alreadyDone + 1;

    const who = board.teamId !== null ? `${board.label} (${solver.nickname})` : solver.nickname;
    const ordinal = board.place === 1 ? "first" : `#${board.place}`;
    this.#pushFeed(
      "solve",
      this.config.mode === "coop"
        ? `found it: "${this.secret}"`
        : `found it ${ordinal} in ${guessesMade(board)} guesses`,
      solver.id,
      who,
    );

    // What the first finisher does to everyone else is the room's house rule.
    if (board.place === 1 && this.config.mode !== "coop" && this.boards.size > 1) {
      if (this.config.finish === "first") {
        this.#pushFeed("round", "Sudden death — the round ends there");
        this.endRound();
        // endRound has already moved the phase on; #maybeEndRound would be a
        // no-op but the early return makes that a fact rather than a guess.
        return;
      }
      if (this.config.finish === "grace") {
        const grace = Math.max(0, this.config.graceSeconds);
        if (grace > 0) {
          this.graceStartedAt = this.now();
          const deadline = this.now() + grace * 1000;
          this.roundEndsAt = this.roundEndsAt === null
            ? deadline
            : Math.min(this.roundEndsAt, deadline);
          this.#scheduleTimer();
        }
      }
      // "everyone": the round runs on until the last board finds it, or the host
      // ends it by hand.
    }

    this.#maybeEndRound();
  }

  // -------------------------------------------------------------------------
  // Hints
  // -------------------------------------------------------------------------

  hint(playerId: string): { word: string; rank: number } {
    const { player, board, secret } = this.#hintPreconditions(playerId);
    if (board.hintsUsed >= this.config.hintsPerBoard) {
      throw new RoomError(
        "noHints",
        this.config.extraHints
          ? "No hints left on this board — but you can buy one."
          : "No hints left on this board.",
      );
    }
    return this.#giveHint(player, board, secret, false);
  }

  /**
   * A hint past the allowance, paid for in drinks.
   *
   * The price is social rather than mechanical, which is the joke: nothing in
   * the game stops you, the room simply finds out. That is why it posts to the
   * feed in the buyer's name — a tab nobody can see is not a tab.
   */
  extraHint(playerId: string): { word: string; rank: number; drinks: number } {
    if (!this.config.extraHints) {
      throw new RoomError("noHints", "Extra hints are switched off for this match.");
    }
    const { player, board, secret } = this.#hintPreconditions(playerId);
    // Only sold once the free ones are gone, so nobody buys a drink for a hint
    // they already had.
    if (board.hintsUsed < this.config.hintsPerBoard) {
      throw new RoomError("noHints", "You still have hints left — use those first.");
    }
    const given = this.#giveHint(player, board, secret, true);
    return { ...given, drinks: player.drinks };
  }

  #hintPreconditions(playerId: string): { player: Player; board: Board; secret: string } {
    const player = this.players.get(playerId);
    if (!player) throw new RoomError("noPlayer", "You are not in this room.");
    if (this.phase !== "playing" || !this.secret) {
      throw new RoomError("closed", "No round is running.");
    }
    const board = this.boardFor(playerId);
    if (!board) throw new RoomError("closed", "You have no board this round.");
    if (board.solved) throw new RoomError("closed", "This board already found it.");
    return { player, board, secret: this.secret };
  }

  #giveHint(
    player: Player,
    board: Board,
    secret: string,
    paid: boolean,
  ): { word: string; rank: number } {
    const playerId = player.id;
    const target = hintTargetRank(board.hintsUsed, board.bestRank);
    const ceiling = board.bestRank !== null ? board.bestRank : Number.POSITIVE_INFINITY;
    // Pass the word source so a themed game gets themed hints.
    const word = this.ranker.hintAt(secret, target, board.seen, ceiling, this.config.wordSource);
    if (!word) throw new RoomError("noHints", "No useful hint left — you are very close.");

    const rank = this.ranker.rank(secret, word)!;
    board.hintsUsed++;
    // Charged only once the hint actually lands, so a request that finds nothing
    // useful does not put a drink on somebody's tab for nothing.
    if (paid) player.drinks++;
    this.#addRow(board, {
      n: ++this.#guessSeq,
      word,
      rank,
      byPlayerId: "hint",
      byNickname: "hint",
      at: this.now(),
      hint: true,
    });
    if (paid) {
      // Posted in their name, not the board's: buying the round is personal even
      // when the hint lands on a shared board.
      this.#pushFeed(
        "hint",
        `bought an extra hint 🍻 — that's ${player.drinks} drink${
          player.drinks === 1 ? "" : "s"
        } they owe the room`,
        playerId,
        player.nickname,
      );
    } else {
      this.#pushFeed(
        "hint",
        `used a hint (${this.config.hintsPerBoard - board.hintsUsed} left)`,
        playerId,
        board.label,
      );
    }

    if (this.config.aiClues && this.#deps.clueProvider) {
      this.#requestClue(board);
    }

    this.#touch();
    return { word, rank };
  }

  /**
   * Ask the clue provider for prose in the background. Deliberately fire and
   * forget: a slow or missing `claude` binary must never stall a guess.
   */
  #requestClue(board: Board): void {
    const provider = this.#deps.clueProvider;
    const secret = this.secret;
    if (!provider || !secret) return;
    const boardId = board.id;
    provider
      .clue(secret, {
        bestRank: board.bestRank,
        guesses: board.guesses.slice(-12).map((g) => g.word),
        wordSource: this.config.wordSource,
      })
      .then((text) => {
        const live = this.boards.get(boardId);
        // Discard if the round moved on while we were waiting.
        if (!live || this.secret !== secret || this.phase !== "playing") return;
        live.clue = text;
        this.#touch();
      })
      .catch((err) => {
        console.warn(`[room ${this.code}] clue provider failed: ${err.message}`);
      });
  }

  // -------------------------------------------------------------------------
  // Social
  // -------------------------------------------------------------------------

  /**
   * Shake everyone else's window.
   *
   * Buzz exists to interrupt people, so the only real design question is how
   * hard it is to abuse. Two answers: a cooldown, and nothing at all happens
   * when you are the only one connected — a buzz into an empty room is either a
   * mistake or someone testing whether it annoys people.
   *
   * Returns who to shake; the room does not own sockets. `recipients` includes
   * the buzzer: pressing the button and having nothing happen on your own screen
   * reads as a button that did not work, and there is no way to tell from your
   * own window whether anyone else jumped.
   */
  buzz(playerId: string): { nickname: string; recipients: string[] } {
    const player = this.players.get(playerId);
    if (!player) throw new RoomError("noPlayer", "You are not in this room.");
    const others = [...this.players.values()].filter((p) => p.connected && p.id !== playerId);
    if (others.length === 0) {
      throw new RoomError("alone", "There is nobody else here to buzz.");
    }
    const now = this.now();
    const waited = now - player.lastBuzzAt;
    if (player.lastBuzzAt > 0 && waited < BUZZ_COOLDOWN_MS) {
      throw new RoomError(
        "tooFast",
        `Give it ${Math.ceil((BUZZ_COOLDOWN_MS - waited) / 1000)}s before buzzing again.`,
      );
    }
    player.lastBuzzAt = now;
    this.#pushFeed("buzz", "buzzed the room ⚡", playerId, player.nickname);
    this.#touch();
    return { nickname: player.nickname, recipients: [playerId, ...others.map((p) => p.id)] };
  }

  /**
   * Throw a rose or an egg at somebody. Returns who to animate it for.
   *
   * Throw as many as you like: one egg is a comment and a dozen is a bit, and
   * capping it at one turned the funniest version of this into a button that
   * greys out. What is capped is the rate and the number kept per sender, which
   * bounds the memory at room size no matter how hard anyone leans on it.
   *
   * The tally rides along in the snapshot, but an animation is an event, not a
   * state: a count that goes from 1 to 2 tells a browser nothing about when to
   * throw an egg, or which direction it came from. So the room says who took
   * part and the socket layer tells the whole room, thrower included — watching
   * your own egg land is most of the fun of throwing it.
   */
  react(actorId: string, targetId: string, kind: ReactionKind): {
    actorNickname: string;
    targetNickname: string;
    count: number;
    total: number;
    audience: string[];
  } {
    const actor = this.players.get(actorId);
    const target = this.players.get(targetId);
    if (!actor) throw new RoomError("noPlayer", "You are not in this room.");
    if (!target) throw new RoomError("noPlayer", "That player is not in the room.");
    if (actorId === targetId) {
      throw new RoomError("badTarget", "Throwing things at yourself is not a strategy.");
    }
    if (!REACTION_KEYS.includes(kind)) throw new RoomError("badTarget", "No such reaction.");

    const now = this.now();
    actor.recentReactions = actor.recentReactions.filter((t) => now - t < REACTION_WINDOW_MS);
    if (actor.recentReactions.length >= REACTIONS_PER_WINDOW) {
      throw new RoomError("tooFast", "Out of ammunition for a second — let it land.");
    }
    actor.recentReactions.push(now);

    let bucket = target.reactions.get(kind);
    if (!bucket) {
      bucket = new Map();
      target.reactions.set(kind, bucket);
    }
    const count = Math.min((bucket.get(actorId) ?? 0) + 1, REACTION_MAX_PER_SENDER);
    bucket.set(actorId, count);
    let total = 0;
    for (const n of bucket.values()) total += n;

    // The first one is news. After that only a pile is, or a barrage would push
    // the actual conversation out of the feed one egg at a time.
    if (count === 1) {
      this.#pushFeed(
        "react",
        `${REACTIONS[kind].verb} ${target.nickname} ${REACTIONS[kind].glyph}`,
        actorId,
        actor.nickname,
      );
    } else if (count % REACTION_FEED_MILESTONE === 0) {
      this.#pushFeed(
        "react",
        REACTIONS[kind].pile(target.nickname, count),
        actorId,
        actor.nickname,
      );
    }
    this.#touch();
    return {
      actorNickname: actor.nickname,
      targetNickname: target.nickname,
      count,
      total,
      audience: [...this.players.values()].filter((p) => p.connected).map((p) => p.id),
    };
  }

  // -------------------------------------------------------------------------
  // Journeys
  // -------------------------------------------------------------------------

  /**
   * Whether `viewerId` may read `targetId`'s guesses for the round in progress.
   *
   * Four ways in, and the third is the one worth stating: once you have found
   * the word there is nothing left to protect, so your run opens to the room
   * automatically. Before that it is yours to give away.
   */
  #mayWatch(viewerId: string, targetId: string, board: Board): boolean {
    if (viewerId === targetId) return true;
    const mine = this.boardFor(viewerId);
    if (mine !== null && mine.id === board.id) return true;
    if (board.solved) return true;
    return this.#journeyGrants.get(targetId)?.has(viewerId) ?? false;
  }

  /**
   * Ask to watch somebody's round. Returns the pair of names so the caller can
   * route the question; the room itself sends nothing.
   */
  requestJourney(
    viewerId: string,
    targetId: string,
  ): { viewerNickname: string; targetNickname: string } {
    const viewer = this.players.get(viewerId);
    const target = this.players.get(targetId);
    if (!viewer) throw new RoomError("noPlayer", "You are not in this room.");
    if (!target) throw new RoomError("noPlayer", "That player is not in the room.");
    if (viewerId === targetId) throw new RoomError("badTarget", "That is your own journey.");
    if (this.phase !== "playing") {
      throw new RoomError("closed", "The round is over — their journey is already open.");
    }
    const board = this.boardFor(targetId);
    if (!board) throw new RoomError("closed", "They have no board this round.");
    if (this.#mayWatch(viewerId, targetId, board)) {
      throw new RoomError("already", "You can already see that one.");
    }
    if (!target.connected) {
      throw new RoomError("offline", `${target.nickname} is not connected to answer.`);
    }
    return { viewerNickname: viewer.nickname, targetNickname: target.nickname };
  }

  /**
   * Answer somebody's request. A refusal is deliberately not recorded: it should
   * cost nothing to say no, and a stored "no" would only be there to hold
   * against them later.
   */
  decideJourney(targetId: string, viewerId: string, approve: boolean): void {
    const target = this.players.get(targetId);
    const viewer = this.players.get(viewerId);
    if (!target || !viewer) throw new RoomError("noPlayer", "That player has left.");
    if (!approve) return;
    let grants = this.#journeyGrants.get(targetId);
    if (!grants) {
      grants = new Set();
      this.#journeyGrants.set(targetId, grants);
    }
    grants.add(viewerId);
    this.#pushFeed(
      "system",
      `is letting ${viewer.nickname} watch their round`,
      targetId,
      target.nickname,
    );
    this.#touch();
  }

  /** The rows on `board` that belong to `playerId` — their guesses, plus the
   * board's hints, which landed in front of them whoever paid for them. */
  #stepsFor(board: Board, playerId: string): JourneyStep[] {
    const rows = board.guesses.filter((g) => g.hint || g.byPlayerId === playerId);
    const tail = rows.length > JOURNEY_STEP_LIMIT ? rows.slice(-JOURNEY_STEP_LIMIT) : rows;
    return tail.map((g) => ({ word: g.word, rank: g.rank, at: g.at, hint: g.hint }));
  }

  /**
   * The best rank to credit a player with on a given board.
   *
   * On their own board that is the board's best, hints included — it is all
   * theirs. On a shared board it is their own best guess, because a teammate's
   * breakthrough is not their achievement to report. Same rule `publicPlayers`
   * follows, so the journey and the standings never disagree.
   */
  #personalBest(board: Board, player: Player | undefined): number | null {
    if (!player) return board.bestRank;
    return board.teamId === null && board.id === `p:${player.id}`
      ? board.bestRank
      : player.bestRank;
  }

  /** Freeze the round that just ended into each player's history. */
  #recordJourneys(secret: string, scoreBefore: Map<string, number>): void {
    const entries = new Map<string, JourneyEntry>();
    for (const player of this.players.values()) {
      const board = this.boardFor(player.id);
      if (!board) continue;
      const steps = this.#stepsFor(board, player.id);
      entries.set(player.id, {
        nickname: player.nickname,
        teamId: player.teamId,
        boardId: board.id,
        solved: board.solved,
        place: board.place,
        guesses: board.guesses.filter((g) => !g.hint && g.byPlayerId === player.id).length,
        hints: board.guesses.filter((g) => g.hint).length,
        bestRank: this.#personalBest(board, player),
        points: player.score - (scoreBefore.get(player.id) ?? player.score),
        steps,
      });
    }
    this.#history.push({ number: this.round, secret, entries });
    if (this.#history.length > JOURNEY_HISTORY_LIMIT) {
      this.#history.splice(0, this.#history.length - JOURNEY_HISTORY_LIMIT);
    }
  }

  /**
   * One player's path to the word, as `viewerId` is allowed to see it.
   *
   * The privacy rule is the same one the board snapshots follow: mid-round you
   * see only boards you are on. Rounds that are over are open to the room —
   * that is the whole point of a post-mortem. Counts are public either way, so a
   * withheld round still reports how many guesses it took.
   */
  journeyFor(viewerId: string, targetId: string): Journey | null {
    const player = this.players.get(targetId);
    const historic = [...this.#history].reverse().find((r) => r.entries.has(targetId));
    if (!player && !historic) return null;

    const rounds: JourneyRound[] = [];
    for (const record of this.#history) {
      const entry = record.entries.get(targetId);
      if (!entry) continue;
      rounds.push({
        number: record.number,
        secret: this.config.revealOnEnd ? record.secret : null,
        solved: entry.solved,
        place: entry.place,
        bestRank: entry.bestRank,
        points: entry.points,
        guesses: entry.guesses,
        hints: entry.hints,
        hidden: false,
        steps: entry.steps,
      });
    }

    // The round in progress is not in history yet, and is the one with rules.
    let needsApproval = false;
    if (this.phase === "playing") {
      const board = this.boardFor(targetId);
      if (board) {
        const visible = this.#mayWatch(viewerId, targetId, board);
        needsApproval = !visible;
        const steps = visible ? this.#stepsFor(board, targetId) : [];
        rounds.push({
          number: this.round,
          secret: null,
          solved: board.solved,
          place: board.place,
          bestRank: this.#personalBest(board, player),
          points: 0,
          guesses: board.guesses.filter((g) => !g.hint && g.byPlayerId === targetId).length,
          hints: board.guesses.filter((g) => g.hint).length,
          hidden: !visible,
          steps,
        });
      }
    }

    let guesses = 0;
    let hints = 0;
    let solves = 0;
    let bestRank: number | null = null;
    for (const r of rounds) {
      guesses += r.guesses;
      hints += r.hints;
      if (r.solved) solves++;
      if (r.bestRank !== null && (bestRank === null || r.bestRank < bestRank)) {
        bestRank = r.bestRank;
      }
    }

    const latest = historic?.entries.get(targetId);
    return {
      playerId: targetId,
      nickname: player?.nickname ?? latest?.nickname ?? "player",
      teamId: player?.teamId ?? latest?.teamId ?? null,
      // Only worth offering the "ask them" button when they are actually here
      // to answer it.
      needsApproval: needsApproval && (player?.connected ?? false),
      rounds,
      totals: { guesses, hints, solves, bestRank, score: player?.score ?? 0 },
    };
  }

  // -------------------------------------------------------------------------
  // Chat and feed
  // -------------------------------------------------------------------------

  /**
   * Say something in the room.
   *
   * Returns who the line tagged, so the socket layer can go and get their
   * attention. Empty when nobody was tagged, which is the usual case.
   */
  chat(playerId: string, text: string): string[] {
    const player = this.players.get(playerId);
    if (!player) return [];
    // cleanText, not slice: the limit counts characters as a person sees them,
    // so a line of pasted emoji is not cut through the middle of one.
    const clean = cleanText(text, LIMITS.maxChatLength);
    if (!clean) return [];
    // A round in progress means chat could leak the answer between boards, but
    // that is the room's business, not ours — teams need to talk.
    const mentions = this.#mentionsIn(clean, playerId);
    this.#pushFeed("chat", clean, playerId, player.nickname, mentions);
    this.#touch();
    return mentions;
  }

  /**
   * Who a line tagged with `@`.
   *
   * Longest name first, so in a room holding both "Duc" and "Duc M" the line
   * `@Duc M` reaches the person it names rather than the one whose name is a
   * prefix of theirs. Matching is case-insensitive and ignores the punctuation
   * that ends a sentence, because "@duc," is plainly still @Duc.
   *
   * `@all` and `@room` reach everybody. They are deliberately not a special
   * permission: the chat rate limit is the only thing standing between anybody and
   * shouting, and it already is.
   *
   * The author is never in the result. Tagging yourself is a way to check the
   * feature works, not a notification worth ringing your own bell for.
   */
  #mentionsIn(text: string, authorId: string): string[] {
    if (!text.includes("@")) return [];
    const lower = text.toLowerCase();
    const everyone = /(^|[^\w@])@(all|room)\b/.test(lower);
    const hit = new Set<string>();

    if (everyone) {
      for (const p of this.players.values()) if (p.id !== authorId) hit.add(p.id);
      return [...hit];
    }

    const byLength = [...this.players.values()]
      .filter((p) => p.id !== authorId)
      .sort((a, b) => b.nickname.length - a.nickname.length);
    for (const p of byLength) {
      const name = p.nickname.toLowerCase();
      if (!name) continue;
      let from = 0;
      while (true) {
        const at = lower.indexOf(`@${name}`, from);
        if (at < 0) break;
        from = at + 1;
        // The @ has to start a word, or an email address would tag half the room:
        // "me@bo.example" names nobody.
        const before = at > 0 ? lower[at - 1] : "";
        if (before && /[\w@.]/.test(before)) continue;
        // And the name must not be part of a longer one — "@ann" does not tag Ann
        // inside "@annabel", which the longest-first ordering has already claimed.
        const after = lower[at + 1 + name.length];
        if (after === undefined || !/\w/.test(after)) {
          hit.add(p.id);
          break;
        }
      }
    }
    return [...hit];
  }

  /**
   * A line of room narration, in the language of the game being played.
   *
   * The room's own events — somebody joined, somebody dropped, the host changed
   * — belong to the room rather than to either game, but they are read in the
   * middle of one of them, and a Vietnamese board with "Bình disconnected" in
   * the feed is half-translated. Only the room's own lines need this: everything
   * the board game says, it says in Vietnamese already.
   */
  #inWords(en: string, vi: string): string {
    return isBoardMode(this.config.mode) ? vi : en;
  }

  #pushFeed(
    kind: FeedItem["kind"],
    text: string,
    playerId?: string,
    actor?: string,
    mentions?: string[],
    icon?: string,
  ): void {
    const item: FeedItem = { n: ++this.#feedSeq, at: this.now(), kind, text, actor, playerId };
    if (mentions?.length) item.mentions = mentions;
    if (icon) item.icon = icon;
    this.#feed.push(item);
    if (this.#feed.length > FEED_LIMIT) this.#feed.splice(0, this.#feed.length - FEED_LIMIT);
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  #scheduleTimer(): void {
    this.#clearTimer();
    if (this.phase !== "playing" || this.roundEndsAt === null) return;
    const delay = Math.max(0, this.roundEndsAt - this.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.phase === "playing") this.endRound();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  close(): void {
    this.#closed = true;
    this.#clearTimer();
    if (this.#monoTimer !== null) {
      clearTimeout(this.#monoTimer);
      this.#monoTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  #requireHost(actorId: string): void {
    if (actorId !== this.hostId) throw new RoomError("notHost", "Only the host can do that.");
  }

  publicPlayers(): PublicPlayer[] {
    const scope = boardScope(this.config.mode);
    return [...this.players.values()].map((p) => {
      const board = scope === "player" ? this.boards.get(`p:${p.id}`) : null;
      return {
        id: p.id,
        nickname: p.nickname,
        connected: p.connected,
        isHost: p.id === this.hostId,
        teamId: p.teamId,
        // On a personal board the board's best rank *is* the player's. On shared
        // boards we show the player's own contribution instead.
        bestRank: board ? board.bestRank : p.bestRank,
        // Hints are not guesses. `p.guessCount` already excludes them, so
        // filtering here is what makes the two branches mean the same thing —
        // and what lets the journey view and the standings agree on a number.
        guessCount: board ? guessesMade(board) : p.guessCount,
        solved: board ? board.solved : (this.boardFor(p.id)?.solved ?? false),
        place: board ? board.place : (this.boardFor(p.id)?.place ?? null),
        score: p.score,
        // Resolved to current nicknames here rather than stored as names, so a
        // rename mid-round does not leave a rose credited to somebody who no
        // longer goes by that.
        reactions: this.#reactionsOf(p),
        drinks: p.drinks,
        // Sent only when there is a board to be watching, so the word game's
        // snapshot is unchanged.
        spectator: this.mono ? !this.mono.hasSeat(p.id) : undefined,
        auto: this.mono ? p.autoPlay : undefined,
      };
    });
  }

  /** Every kind somebody has actually been hit with. Empty kinds are omitted. */
  #reactionsOf(player: Player): Partial<Record<ReactionKind, ReactionTally[]>> {
    const out: Partial<Record<ReactionKind, ReactionTally[]>> = {};
    for (const [kind, counts] of player.reactions) {
      const tallies = this.#talliesOf(counts);
      if (tallies.length) out[kind] = tallies;
    }
    return out;
  }

  /**
   * Turn a sender-id tally into one keyed by current nickname, biggest first.
   *
   * Senders who have since left the room drop out: a rose from somebody who is
   * no longer here has nobody to credit, and `#forget` has already stopped them
   * being counted, so this is only the ordering and the naming.
   */
  #talliesOf(counts: Map<string, number>): ReactionTally[] {
    const out: ReactionTally[] = [];
    for (const [id, count] of counts) {
      const p = this.players.get(id);
      if (p) out.push({ nickname: p.nickname, count });
    }
    return out.sort((a, b) => b.count - a.count || a.nickname.localeCompare(b.nickname));
  }

  teamViews(): TeamView[] {
    if (boardScope(this.config.mode) !== "team") return [];
    const out: TeamView[] = [];
    for (let teamId = 0; teamId < this.config.teamCount; teamId++) {
      const board = this.boards.get(`t:${teamId}`);
      const memberIds = [...this.players.values()]
        .filter((p) => p.teamId === teamId)
        .map((p) => p.id);
      out.push({
        id: teamId,
        name: teamName(teamId),
        memberIds,
        bestRank: board?.bestRank ?? null,
        guessCount: board ? guessesMade(board) : 0,
        solved: board?.solved ?? false,
        place: board?.place ?? null,
        score: this.teamScores.get(teamId) ?? 0,
      });
    }
    return out;
  }

  standings(): Standing[] {
    const mode = this.config.mode;

    if (this.mono) {
      const view = this.mono.view();
      const unit = view.map.money.unit;
      return [...view.players]
        .sort((a, b) =>
          Number(a.bankrupt) - Number(b.bankrupt) || b.net - a.net || a.order - b.order
        )
        .map((p) => ({
          key: p.id,
          label: `${p.token} ${this.players.get(p.id)?.nickname ?? "—"}`,
          // Net worth, not cash: a player with three hotels and no change in
          // their pocket is winning, and a table that showed cash would say the
          // opposite.
          score: p.net,
          detail: p.bankrupt
            ? "phá sản"
            : p.inJail
            ? `trong tù · ${formatMoney(p.cash, unit)} tiền mặt`
            : `${formatMoney(p.cash, unit)} tiền mặt`,
        }));
    }

    if (mode === "coop") {
      const board = this.boards.get("all");
      return [{
        key: "room",
        label: "Room total",
        score: this.coopTotal,
        detail: board ? `${guessesMade(board)} guesses this round` : `${this.players.size} players`,
      }];
    }

    if (mode === "teams") {
      return this.teamViews()
        .filter((t) => t.memberIds.length > 0)
        .sort((a, b) => b.score - a.score || (a.place ?? 99) - (b.place ?? 99))
        .map((t) => ({
          key: `t:${t.id}`,
          label: t.name,
          score: t.score,
          detail: t.solved
            ? `found it #${t.place} · ${t.guessCount} guesses`
            : t.bestRank !== null
            ? `best rank ${formatRankValue(t.bestRank)}`
            : `${t.memberIds.length} players`,
        }));
    }

    return this.publicPlayers()
      .sort((a, b) =>
        b.score - a.score ||
        (a.place ?? 9999) - (b.place ?? 9999) ||
        (a.bestRank ?? 9e9) - (b.bestRank ?? 9e9) ||
        a.guessCount - b.guessCount
      )
      .map((p) => ({
        key: p.id,
        label: p.nickname,
        score: p.score,
        detail: p.solved
          ? `found it #${p.place} · ${p.guessCount} guesses`
          : p.bestRank !== null
          ? `best rank ${formatRankValue(p.bestRank)} · ${p.guessCount} guesses`
          : "no guesses yet",
      }));
  }

  #boardViewFor(playerId: string): BoardView | null {
    const board = this.boardFor(playerId);
    if (!board) return null;
    return {
      id: board.id,
      label: board.label,
      guesses: board.guesses,
      hintsLeft: Math.max(0, this.config.hintsPerBoard - board.hintsUsed),
      solved: board.solved,
      bestRank: board.bestRank,
      clue: board.clue,
    };
  }

  roundView(): RoundView | null {
    if (this.phase === "lobby") return null;
    if (this.phase === "roundEnd" || this.phase === "matchEnd") return this.#lastRound;
    return {
      number: this.round,
      total: this.totalRounds,
      startedAt: this.roundStartedAt,
      endsAt: this.roundEndsAt,
      secret: null,
      nearMisses: null,
    };
  }

  viewFor(playerId: string): RoomView {
    const player = this.players.get(playerId);
    const stats = this.ranker.stats();
    return {
      code: this.code,
      phase: this.phase,
      config: this.config,
      hostId: this.hostId,
      you: {
        id: playerId,
        nickname: player?.nickname ?? "",
        isHost: playerId === this.hostId,
        teamId: player?.teamId ?? null,
        boardId: this.boardFor(playerId)?.id ?? null,
        spectator: this.isSpectator(playerId),
        auto: player?.autoPlay ?? false,
      },
      players: this.publicPlayers(),
      teams: this.teamViews(),
      round: this.roundView(),
      board: this.#boardViewFor(playerId),
      standings: this.standings(),
      feed: this.#feed,
      serverNow: this.now(),
      rankerInfo: { vocabSize: stats.vocabSize, sample: stats.sample },
      wordSources: wordSourceStatuses(this.ranker),
      mono: this.monoView(),
      // Sent in every mode, not only monopoly: the lobby lets a host switch a
      // room over to the board game, and the picker has to be able to draw
      // itself the moment they do.
      monoMaps: this.monoMapSummaries(),
    };
  }
}

/**
 * Report which word sources this server can actually play. Shared with
 * /api/info so the landing page and the lobby agree.
 */
export function wordSourceStatuses(ranker: Ranker): WordSourceStatus[] {
  return (Object.keys(WORD_SOURCES) as WordSource[]).map((key) => {
    const size = ranker.pool(key).length;
    const file = (WORD_SOURCES[key] as { file: string | null }).file;
    let note = "";
    if (size === 0) {
      note = file
        ? `No playable words. Missing ${file}, or none of its words are in the ` +
          `embedding pack — build a bigger pack with \`deno task ingest\`.`
        : "No playable words in this pack.";
    } else {
      note = `${size.toLocaleString()} words`;
    }
    return { key, size, available: size > 0, note };
  });
}

// ---------------------------------------------------------------------------

export class RoomError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "RoomError";
  }
}

function makeBoard(id: string, label: string, teamId: number | null): Board {
  return {
    id,
    label,
    members: new Set(),
    teamId,
    guesses: [],
    seen: new Set(),
    hintsUsed: 0,
    spent: 0,
    bestRank: null,
    solved: false,
    solvedAt: null,
    place: null,
    clue: null,
  };
}

function teamName(teamId: number): string {
  return TEAM_NAMES[teamId] ?? `Team ${teamId + 1}`;
}

/**
 * Rows on a board that somebody actually guessed.
 *
 * Hints share the guess list because they belong on the board, but they are not
 * guesses anyone made. Everything a player reads — the standings, the journey,
 * the feed — counts them out, so the same round never shows two numbers.
 */
function guessesMade(board: Board): number {
  return board.guesses.filter((g) => !g.hint).length;
}

/**
 * Stripping control characters is precisely the intent: without it a nickname
 * could smuggle newlines or terminal escapes into the room feed. What it must
 * *not* do is damage an emoji someone put in their name, so the rule lives in
 * shared/text.js beside the one chat uses rather than as a regex here.
 */
export function cleanNickname(raw: string): string {
  return cleanText(raw, LIMITS.maxNicknameLength);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function sanitiseConfig(raw: RoomConfig): RoomConfig {
  const mode = MODES.includes(raw.mode as never) ? raw.mode : DEFAULT_CONFIG.mode;
  const difficulty = raw.difficulty in DIFFICULTIES ? raw.difficulty : DEFAULT_CONFIG.difficulty;
  const wordSource = raw.wordSource in WORD_SOURCES ? raw.wordSource : DEFAULT_CONFIG.wordSource;
  return {
    mode,
    wordSource,
    difficulty,
    totalRounds: clampInt(
      raw.totalRounds,
      LIMITS.minRounds,
      LIMITS.maxRounds,
      DEFAULT_CONFIG.totalRounds,
    ),
    teamCount: clampInt(raw.teamCount, LIMITS.minTeams, LIMITS.maxTeams, DEFAULT_CONFIG.teamCount),
    roundSeconds: clampInt(
      raw.roundSeconds,
      0,
      LIMITS.maxRoundSeconds,
      DEFAULT_CONFIG.roundSeconds,
    ),
    graceSeconds: clampInt(
      raw.graceSeconds,
      0,
      LIMITS.maxRoundSeconds,
      DEFAULT_CONFIG.graceSeconds,
    ),
    // "custom" is legal here and means "the board this room loaded"; the room
    // falls back to the default if no file was ever loaded, so a stale config
    // cannot leave a room with no board.
    monoMap: typeof raw.monoMap === "string" && raw.monoMap.length <= 48
      ? raw.monoMap
      : DEFAULT_MAP_ID,
    monoAuction: raw.monoAuction === undefined
      ? DEFAULT_CONFIG.monoAuction
      : Boolean(raw.monoAuction),
    monoParkingPot: Boolean(raw.monoParkingPot),
    monoDoubleGo: Boolean(raw.monoDoubleGo),
    hintsPerBoard: clampInt(raw.hintsPerBoard, 0, 10, DEFAULT_CONFIG.hintsPerBoard),
    revealOnEnd: Boolean(raw.revealOnEnd),
    aiClues: Boolean(raw.aiClues),
    finish: FINISH_KEYS.includes(raw.finish as never) ? raw.finish : DEFAULT_CONFIG.finish,
    guessLimit: clampInt(raw.guessLimit, 0, LIMITS.maxGuessBudget, DEFAULT_CONFIG.guessLimit),
    extraHints: Boolean(raw.extraHints),
  };
}
