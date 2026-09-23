// The Monopoly rules, and the only place they live.
//
// The server is authoritative for every one of them. A browser sends "I want to
// buy" and gets told what happened; it never computes rent, never moves a token
// and never decides whose turn it is. That is the same posture as the word game
// next door, for the same reason — a board game where the client is trusted is a
// board game with a cheat button.
//
// Shape of a turn, which the whole file is organised around:
//
//   pending.kind    what the game is waiting for            who answers
//   ------------    ---------------------------------       -----------
//   "roll"          the dice                                 the player in turn
//   "jail"          pay, card, or roll for doubles           the player in turn
//   "buy"           buy this square, or let it go            the player in turn
//   "tax"           flat or percentage                       the player in turn
//   "debt"          raise the money, or go bankrupt          whoever owes
//   "auction"       bids                                     everyone still in
//   "end"           nothing — build, deal, then end turn     the player in turn
//   "over"          nothing, the game is done                nobody
//
// Exactly one of those is live at a time, and every public method starts by
// checking it is the one it belongs to. That check is the whole turn order.

import {
  AUTO_END_MS,
  AUTO_IDLE_MS,
  CHEST_TIERS,
  DEFAULT_TIER,
  drawChestCard,
  formatMoney,
  goSlot,
  groupMembers,
  isOwnable,
  JAIL_TURNS,
  jailSlot,
  MAX_HOUSES,
  nearestOfKind,
  placesByRank,
  SEAT_HUES,
  TRANSPORT_RENT,
  UTILITY_MULTIPLIER,
} from "../shared/monopoly.js";
import { LIMITS } from "../shared/constants.js";
import type {
  MonoAuctionView,
  MonoCardView,
  MonoPendingView,
  MonoPlayerView,
  MonopolyView,
  MonoSpaceView,
  MonoTradeView,
} from "../shared/protocol.ts";

/**
 * Classic Monopoly is 2–8. Past that nobody gets a colour group.
 *
 * Re-exported from LIMITS rather than written here, because the lobby has to
 * count up to the same number and a browser that thought nine could sit down
 * would let a ninth person watch a room fill without them.
 */
export const MAX_MONOPOLY_PLAYERS = LIMITS.maxBoardPlayers;
export const MIN_MONOPOLY_PLAYERS = LIMITS.minBoardPlayers;

/** Three doubles in a row and the third one takes you to jail, not forward. */
const DOUBLES_TO_JAIL = 3;
/**
 * Unmortgaging costs the mortgage back plus this much interest, as a percentage.
 *
 * Held as a percentage and applied with integer arithmetic rather than as `1.1`,
 * because `50 * 1.1` is 55.00000000000001 in binary floating point and the
 * ceiling of that is 56 — a one-unit overcharge that a test caught and no player
 * ever would.
 */
const MORTGAGE_INTEREST_PERCENT = 10;

/**
 * Pieces, in the order they are handed out. Vietnamese things you would
 * recognise on a table rather than a top hat and a thimble.
 */
const TOKENS = ["🛵", "🐉", "🍵", "🐃", "⛵", "🏮", "🍜", "🎋"];

export class MonopolyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "MonopolyError";
  }
}

interface Holding {
  owner: string | null;
  /** 0–4 houses, 5 for a hotel. One number, so the even-build rule is one line. */
  level: number;
  mortgaged: boolean;
}

interface Seat {
  id: string;
  order: number;
  token: string;
  /** Their colour. One per seat, so no two players are ever the same green. */
  hue: number;
  cash: number;
  pos: number;
  inJail: boolean;
  jailTurns: number;
  jailCards: number;
  /** Unspent "the next rent is waived" cards, off the Khí vận draw. */
  shields: number;
  bankrupt: boolean;
}

type Pending =
  | { kind: "roll" }
  | { kind: "jail" }
  | { kind: "buy"; space: number }
  /** Standing on your own street, being asked whether to put a building up. */
  | { kind: "upgrade"; space: number }
  | { kind: "tax"; space: number }
  | { kind: "debt"; who: string; amount: number; to: string | null }
  | { kind: "end" }
  | { kind: "over" };

interface Auction {
  space: number;
  high: number;
  highId: string | null;
  /** Still able to bid. Order is irrelevant: any of them may raise at any time. */
  active: Set<string>;
}

interface Trade {
  id: string;
  fromId: string;
  toId: string;
  giveSpaces: number[];
  giveCash: number;
  wantSpaces: number[];
  wantCash: number;
}

export interface MonopolyRules {
  /** A declined square goes to auction, as the printed rules say it should. */
  auction: boolean;
  /** House rule: fines and taxes pile up under Bãi đỗ xe and go to whoever lands. */
  parkingPot: boolean;
  /** House rule: landing exactly on Xuất phát pays double. */
  doubleGo: boolean;
}

export interface MonopolyDeps {
  /** Name for a player id, for the log. Looked up rather than stored: people rename. */
  nameOf: (id: string) => string;
  /** True while their browser is attached. Only used to allow a skip. */
  connected: (id: string) => boolean;
  /** One narrative line, already in Vietnamese. */
  say: (icon: string, text: string, playerId?: string) => void;
  /** Something observable changed. */
  onChange: () => void;
  random?: () => number;
  now?: () => number;
}

// deno-lint-ignore no-explicit-any
type Board = any;

export class MonopolyGame {
  readonly map: Board;
  readonly rules: MonopolyRules;
  #deps: MonopolyDeps;
  #holdings: Holding[];
  #seats: Seat[] = [];
  #turn = 0;
  #dice: [number, number] | null = null;
  /**
   * How many times the dice have been thrown this game.
   *
   * The faces alone cannot tell one throw from the next — rolling 3–4 twice in a
   * row is two throws that look identical — so the browser has no way to know it
   * should animate again. This counter is that signal, and nothing in the rules
   * reads it.
   */
  #rollNo = 0;
  #doubles = 0;
  #pending: Pending = { kind: "roll" };
  #auction: Auction | null = null;
  #trades: Trade[] = [];
  #tradeSeq = 0;
  /**
   * Cơ hội's shuffled pile, as indices into the map deck, plus where we are.
   *
   * Only Cơ hội has one. Khí vận is drawn by rarity every time rather than dealt
   * from a pile — see `#gacha` — so there is nothing to keep a place in.
   */
  #chance: number[] = [];
  #chanceAt = 0;
  /** The last card drawn, so every browser can show it until the turn moves on. */
  #card: MonoCardView | null = null;
  #pot = 0;
  #round = 1;
  #winnerId: string | null = null;
  /**
   * Landings on your own squares, keyed `"playerId:index"`.
   *
   * The second unlock for building: hold the whole colour group, *or* have come
   * back to this one street twice. Counted per player rather than per square
   * because a street that changes hands should not arrive pre-unlocked.
   */
  #visits = new Map<string, number>();
  /**
   * The square the board is asking about right now, or null.
   *
   * Doubles as the permission to build on a street whose colour group is not
   * complete: `#buildBlock` reads it, so "only while you are standing here" is
   * one condition in one place rather than a rule the browser has to know.
   */
  #upgradeAt: number | null = null;
  /** Cards drawn this game, so the browser can animate a draw exactly once. */
  #cardNo = 0;
  /**
   * Estate moves so far. Bumped by every build, sale, mortgage and deal.
   *
   * Its only job is to sit in the wait key below, so a player who is busy
   * managing their streets is not timed out for taking too long over it.
   */
  #manageNo = 0;
  /** The question on the table, as a key, and the moment it went up. */
  #waitKey = "";
  #waitAt = 0;

  constructor(map: Board, playerIds: string[], rules: MonopolyRules, deps: MonopolyDeps) {
    this.map = map;
    this.rules = rules;
    this.#deps = deps;
    this.#holdings = map.spaces.map(() => ({ owner: null, level: 0, mortgaged: false }));

    const start = map.money.start as number;
    // Seating is shuffled, because going first is worth something and "whoever
    // clicked create" is not a reason to have it.
    const ids = this.#shuffled(playerIds).slice(0, MAX_MONOPOLY_PLAYERS);
    this.#seats = ids.map((id, i) => ({
      id,
      order: i,
      token: TOKENS[i % TOKENS.length],
      hue: SEAT_HUES[i % SEAT_HUES.length],
      cash: start,
      pos: goSlot(map),
      inJail: false,
      jailTurns: 0,
      jailCards: 0,
      shields: 0,
      bankrupt: false,
    }));

    this.#chance = this.#shuffled(map.chance.map((_: unknown, i: number) => i));
    this.#markWait();

    this.#say(
      map.icon,
      `Bàn ${map.name} — mỗi người ${this.money(start)}. ${
        this.#nameOf(this.#current.id)
      } đi trước.`,
    );
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  get #random(): () => number {
    return this.#deps.random ?? Math.random;
  }

  now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  #shuffled<T>(list: T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.#random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  money(amount: number): string {
    return formatMoney(amount, this.map.money.unit);
  }

  #nameOf(id: string): string {
    return this.#deps.nameOf(id) || "người chơi";
  }

  #say(icon: string, text: string, playerId?: string): void {
    this.#deps.say(icon, text, playerId);
  }

  get #current(): Seat {
    return this.#seats[this.#turn];
  }

  get isOver(): boolean {
    return this.#pending.kind === "over";
  }

  get winnerId(): string | null {
    return this.#winnerId;
  }

  #seat(id: string): Seat {
    const seat = this.#seats.find((s) => s.id === id);
    if (!seat) throw new MonopolyError("notPlaying", "Bạn không có trong bàn này.");
    return seat;
  }

  #living(): Seat[] {
    return this.#seats.filter((s) => !s.bankrupt);
  }

  /** The one gate every action goes through: is it your turn, and is this the question? */
  #requireTurn(playerId: string, kinds: Pending["kind"][]): Seat {
    const seat = this.#seat(playerId);
    if (this.isOver) throw new MonopolyError("over", "Trận đã kết thúc.");
    if (seat.bankrupt) throw new MonopolyError("bankrupt", "Bạn đã phá sản.");
    // An open auction suspends the turn. `pending` is deliberately left as it was
    // so the turn resumes where it left off once the hammer falls — which means it
    // still reads as "buy", and without this guard the player who just refused the
    // square could buy it at list price mid-auction, or refuse it a second time
    // and wipe out everybody's bids. Raising cash is still allowed: mortgaging to
    // fund a bid goes through #requireManage, not through here.
    if (this.#auction) {
      throw new MonopolyError(
        "auctionOpen",
        `Đang đấu giá ${this.map.spaces[this.#auction.space].name} — ` +
          `trả giá hoặc rút khỏi phiên trước.`,
      );
    }
    // A debt is answered by whoever owes it, which is not always the player in turn:
    // rent can bankrupt somebody on another player's roll.
    if (this.#pending.kind === "debt") {
      if (this.#pending.who !== playerId) {
        throw new MonopolyError(
          "waiting",
          `Đang chờ ${this.#nameOf(this.#pending.who)} trả nợ.`,
        );
      }
      if (!kinds.includes("debt")) {
        throw new MonopolyError("debt", "Bạn đang mắc nợ — trả nợ hoặc tuyên bố phá sản trước.");
      }
      return seat;
    }
    if (this.#current.id !== playerId) {
      throw new MonopolyError(
        "notYourTurn",
        `Chưa tới lượt bạn — đang là ${this.#nameOf(this.#current.id)}.`,
      );
    }
    if (!kinds.includes(this.#pending.kind)) {
      throw new MonopolyError("wrongStep", PENDING_COMPLAINT[this.#pending.kind]);
    }
    return seat;
  }

  #touch(): void {
    this.#markWait();
    this.#deps.onChange();
  }

  /**
   * Notice when the question on the table changed, and restart the clock on it.
   *
   * Derived from a key rather than stamped at every assignment to `#pending`,
   * because there are two dozen of those and the twenty-fifth would have been
   * the one that forgot. The roll count is in the key so a second throw off a
   * double is a fresh wait, and the estate counter is in it so building does
   * not run the clock down on the player doing the building.
   */
  #markWait(): void {
    const p = this.#pending;
    const who = p.kind === "debt" ? p.who : this.#current?.id ?? "";
    const key = `${p.kind}:${who}:${this.#rollNo}:${this.#manageNo}:${this.#auctionKey()}`;
    if (key === this.#waitKey) return;
    this.#waitKey = key;
    this.#waitAt = this.now();
  }

  /**
   * As much of an open auction as changes the question on the table.
   *
   * The standing bid and the number of people still in are both in here, so a
   * bid or a withdrawal restarts everybody's clock: the question in an auction
   * is "will you go higher than this", and a new highest bid is a new question.
   * A bare `has an auction / does not` flag left the fuse running from the
   * moment the hammer went up, whatever anybody did about it.
   */
  #auctionKey(): string {
    const a = this.#auction;
    return a ? `${a.space}/${a.high}/${a.active.size}` : "-";
  }

  // -------------------------------------------------------------------------
  // Money
  // -------------------------------------------------------------------------

  /**
   * What the buildings standing on one square sell back for: half price, and
   * nothing at all on a square that cannot be built on.
   *
   * In one place because `space.house` exists only on places — a station or a
   * utility has no house price — and `0 * undefined` is NaN. A NaN that reached
   * somebody's cash would never come back out of it: every later sum is NaN,
   * every comparison against it is false, and JSON sends it as `null`.
   */
  #sellBack(index: number, level: number): number {
    const house = this.map.spaces[index].house;
    return house ? level * Math.floor(house / 2) : 0;
  }

  /** What they could raise if they sold and mortgaged everything they hold. */
  #liquid(seat: Seat): number {
    let total = seat.cash;
    this.#holdings.forEach((h, i) => {
      if (h.owner !== seat.id) return;
      const space = this.map.spaces[i];
      total += this.#sellBack(i, h.level);
      if (!h.mortgaged) total += Math.floor(space.price / 2);
    });
    return total;
  }

  /** Cash plus what everything is worth on paper. The number the table watches. */
  net(seat: Seat): number {
    let total = seat.cash;
    this.#holdings.forEach((h, i) => {
      if (h.owner !== seat.id) return;
      const space = this.map.spaces[i];
      total += h.mortgaged ? Math.floor(space.price / 2) : space.price;
      // Only places carry buildings, and a station has no house price at all.
      // Guarded rather than assumed: `0 * undefined` is NaN, JSON sends NaN as
      // null, and a null net worth is both a "null" in the standings and a
      // comparison that quietly fails in every sort that ranks by it — the
      // end-of-game award included.
      if (space.house) total += h.level * space.house;
    });
    return total;
  }

  /**
   * Move money, and stop the game if it cannot be moved.
   *
   * A player short of cash is not bankrupt — they may have three streets to
   * mortgage — so a shortfall becomes a `debt` the game waits on rather than an
   * instant elimination. `to === null` means the bank.
   */
  #charge(seat: Seat, amount: number, to: string | null, why: string): void {
    if (amount <= 0) return;
    if (seat.cash >= amount) {
      seat.cash -= amount;
      this.#credit(to, amount, why);
      return;
    }
    this.#pending = { kind: "debt", who: seat.id, amount, to };
    this.#say(
      "🚨",
      `${this.#nameOf(seat.id)} thiếu tiền: cần ${this.money(amount)} (${why}), ` +
        `còn ${this.money(seat.cash)}. Bán nhà, thế chấp, hoặc tuyên bố phá sản.`,
      seat.id,
    );
  }

  #credit(to: string | null, amount: number, why: string): void {
    if (to === null) {
      // The bank. Under the house rule it goes to the middle instead, which is
      // the only reason a fine paid to nobody needs recording at all.
      if (this.rules.parkingPot && FINES_TO_POT.has(why)) this.#pot += amount;
      return;
    }
    const seat = this.#seats.find((s) => s.id === to);
    if (seat) seat.cash += amount;
  }

  #pay(seat: Seat, amount: number, _why: string): void {
    if (amount <= 0) return;
    seat.cash += amount;
  }

  // -------------------------------------------------------------------------
  // Rolling and moving
  // -------------------------------------------------------------------------

  roll(playerId: string): void {
    const seat = this.#requireTurn(playerId, ["roll", "jail"]);
    const a = 1 + Math.floor(this.#random() * 6);
    const b = 1 + Math.floor(this.#random() * 6);
    this.#dice = [a, b];
    this.#rollNo++;
    this.#card = null;
    const total = a + b;
    const isDouble = a === b;
    const name = this.#nameOf(seat.id);

    if (seat.inJail) {
      this.#say("🎲", `${name} tung ${a}–${b} khi đang ở tù.`, seat.id);
      if (isDouble) {
        seat.inJail = false;
        seat.jailTurns = 0;
        this.#say("🔓", `Đôi ${a}! ${name} được ra tù và đi ${total} ô.`, seat.id);
        // Out on doubles does *not* earn another roll, or jail would be a bonus.
        this.#doubles = 0;
        this.#advance(seat, total);
        return;
      }
      seat.jailTurns++;
      if (seat.jailTurns >= JAIL_TURNS) {
        this.#say(
          "💸",
          `Hết ${JAIL_TURNS} lượt — ${name} phải nộp ${
            this.money(this.map.money.bail)
          } và đi tiếp.`,
          seat.id,
        );
        seat.inJail = false;
        seat.jailTurns = 0;
        this.#charge(seat, this.map.money.bail, null, "tiền bảo lãnh");
        if (this.#pending.kind === "debt") return;
        this.#advance(seat, total);
        return;
      }
      this.#say(
        "🔒",
        `Không phải đôi — ${name} ở lại tù (lượt ${seat.jailTurns}/${JAIL_TURNS}).`,
        seat.id,
      );
      this.#endTurnInternal();
      return;
    }

    if (isDouble) {
      this.#doubles++;
      if (this.#doubles >= DOUBLES_TO_JAIL) {
        this.#say("🚔", `Đôi ${a} lần thứ ba — ${name} vào tù ngay!`, seat.id);
        this.#sendToJail(seat);
        return;
      }
      this.#say("🎲", `${name} tung ${a}–${b} = ${total} (đôi, được tung lại).`, seat.id);
    } else {
      this.#doubles = 0;
      this.#say("🎲", `${name} tung ${a}–${b} = ${total}.`, seat.id);
    }
    this.#advance(seat, total);
  }

  /** Forward `steps`, collecting salary for every pass of Xuất phát. */
  #advance(seat: Seat, steps: number): void {
    const size = this.map.spaces.length;
    const go = goSlot(this.map);
    for (let n = 0; n < steps; n++) {
      seat.pos = (seat.pos + 1) % size;
      if (seat.pos === go) this.#collectSalary(seat, false);
    }
    this.#land(seat);
  }

  #moveTo(seat: Seat, index: number, salary: boolean): void {
    const size = this.map.spaces.length;
    const go = goSlot(this.map);
    if (salary) {
      // Passing GO on the way is what earns the salary, so walk it rather than
      // teleporting — a card that sends you forward past GO pays, one that sends
      // you back past it does not.
      let steps = (index - seat.pos + size) % size;
      if (steps === 0) steps = size;
      for (let n = 0; n < steps; n++) {
        seat.pos = (seat.pos + 1) % size;
        if (seat.pos === go) this.#collectSalary(seat, false);
      }
    } else {
      seat.pos = ((index % size) + size) % size;
    }
    this.#land(seat);
  }

  #collectSalary(seat: Seat, landedExactly: boolean): void {
    const base = this.map.money.go as number;
    const amount = landedExactly && this.rules.doubleGo ? base * 2 : base;
    this.#pay(seat, amount, "lương");
    this.#say(
      "🏁",
      `${this.#nameOf(seat.id)} qua Xuất phát, nhận ${this.money(amount)}.`,
      seat.id,
    );
  }

  #sendToJail(seat: Seat): void {
    seat.pos = jailSlot(this.map);
    seat.inJail = true;
    seat.jailTurns = 0;
    this.#doubles = 0;
    // Jail ends the turn outright — no roll-again, even off a double.
    this.#endTurnInternal();
  }

  // -------------------------------------------------------------------------
  // Landing
  // -------------------------------------------------------------------------

  #land(seat: Seat, forced?: { factor: number; kind: "transport" | "utility" }): void {
    const index = seat.pos;
    const space = this.map.spaces[index];
    const name = this.#nameOf(seat.id);
    const label = `${space.icon} ${space.name}`;

    switch (space.kind) {
      case "go":
        // Getting here by walking already paid; this is the exact-landing bonus.
        if (this.rules.doubleGo) {
          this.#pay(seat, this.map.money.go, "lương");
          this.#say(
            "🏁",
            `${name} dừng đúng ô Xuất phát — nhận thêm ${this.money(this.map.money.go)}.`,
            seat.id,
          );
        }
        this.#afterLanding();
        return;

      case "jail":
        this.#say("🚔", `${name} ghé ${label} — chỉ đứng nhìn.`, seat.id);
        this.#afterLanding();
        return;

      case "parking": {
        if (this.rules.parkingPot && this.#pot > 0) {
          const won = this.#pot;
          this.#pot = 0;
          this.#pay(seat, won, "tiền giữa bàn");
          this.#say("🅿️", `${name} vào ${label} và vét ${this.money(won)} ở giữa bàn!`, seat.id);
        } else {
          this.#say("🅿️", `${name} nghỉ ở ${label}.`, seat.id);
        }
        this.#afterLanding();
        return;
      }

      case "gotojail":
        this.#say("👮", `${name} bị đưa vào tù!`, seat.id);
        this.#sendToJail(seat);
        return;

      case "tax": {
        if (space.percent === undefined) {
          this.#say("💎", `${name} vào ${label} — trả ${this.money(space.amount)}.`, seat.id);
          this.#charge(seat, space.amount, null, "thuế xa xỉ");
          if (this.#pending.kind !== "debt") this.#afterLanding();
          return;
        }
        // Income tax is a choice, and the flat rate is not always the cheaper one.
        this.#pending = { kind: "tax", space: index };
        this.#say("🧾", `${name} vào ${label} — chọn trả gọn hay theo phần trăm.`, seat.id);
        this.#touch();
        return;
      }

      case "chance":
      case "chest":
        this.#drawCard(seat, space.kind);
        return;

      case "place":
      case "transport":
      case "utility": {
        const holding = this.#holdings[index];
        if (holding.owner === null) {
          this.#pending = { kind: "buy", space: index };
          this.#say(
            "🏷️",
            `${name} vào ${label} — chưa ai mua, giá ${this.money(space.price)}.`,
            seat.id,
          );
          this.#touch();
          return;
        }
        if (holding.owner === seat.id) {
          // Coming home is where building happens now. Every landing on your own
          // street is the board asking whether to put another storey on it —
          // which is the only moment the answer is interesting, and the only
          // moment everybody else is looking at that square too.
          const visits = this.#visit(seat.id, index);
          this.#say(
            "🏠",
            visits > 1
              ? `${name} về ${label} — nhà mình, lần thứ ${visits}.`
              : `${name} về ${label} — nhà mình.`,
            seat.id,
          );
          this.#offerUpgrade(seat, index);
          return;
        }
        if (holding.mortgaged) {
          this.#say(
            "📄",
            `${name} vào ${label}, đang thế chấp nên không phải trả thuê.`,
            seat.id,
          );
          this.#afterLanding();
          return;
        }
        const rent = this.#rentFor(index, forced);
        const owner = this.#nameOf(holding.owner);
        // A shield off the Khí vận draw is spent here and nowhere else: it waives
        // one rent, so the owner is told what happened rather than left wondering
        // why nothing arrived.
        if (seat.shields > 0) {
          seat.shields--;
          this.#say(
            "🛡️",
            `${name} vào ${label} của ${owner} — có người bảo kê, miễn ${
              this.money(rent)
            } tiền thuê.`,
            seat.id,
          );
          this.#afterLanding();
          return;
        }
        this.#say(
          "💰",
          `${name} vào ${label} của ${owner} — trả tiền thuê ${this.money(rent)}.`,
          seat.id,
        );
        this.#charge(seat, rent, holding.owner, "tiền thuê");
        if (this.#pending.kind !== "debt") this.#afterLanding();
        return;
      }

      default:
        this.#afterLanding();
    }
  }

  /**
   * What is owed on a square right now.
   *
   * `forced` is the card case — "nearest station, pay double" overrides the
   * count-based table, and "nearest utility, ten times the dice" overrides the
   * multiplier even when the owner holds only one.
   */
  #rentFor(index: number, forced?: { factor: number; kind: "transport" | "utility" }): number {
    const space = this.map.spaces[index];
    const holding = this.#holdings[index];
    const dice = (this.#dice?.[0] ?? 0) + (this.#dice?.[1] ?? 0);

    if (space.kind === "transport") {
      const owned = this.#countKind(holding.owner!, "transport");
      const base = TRANSPORT_RENT[Math.min(owned, TRANSPORT_RENT.length) - 1] ?? 0;
      return forced ? base * forced.factor : base;
    }

    if (space.kind === "utility") {
      if (forced) return dice * forced.factor;
      const owned = this.#countKind(holding.owner!, "utility");
      const mult = UTILITY_MULTIPLIER[Math.min(owned, UTILITY_MULTIPLIER.length) - 1] ?? 4;
      return dice * mult;
    }

    if (holding.level > 0) return space.rent[holding.level];
    // Bare rent doubles on a complete colour group — the reason a group is worth
    // holding out for even before you can afford to build.
    return this.#ownsGroup(holding.owner!, space.group) ? space.rent[0] * 2 : space.rent[0];
  }

  #countKind(ownerId: string, kind: string): number {
    let n = 0;
    this.#holdings.forEach((h, i) => {
      if (h.owner === ownerId && this.map.spaces[i].kind === kind) n++;
    });
    return n;
  }

  #ownsGroup(ownerId: string, groupId: string): boolean {
    const members = groupMembers(this.map, groupId);
    return members.length > 0 && members.every((i) => this.#holdings[i].owner === ownerId);
  }

  /**
   * The squares of one colour group that this player actually holds.
   *
   * Even build is enforced across these rather than across the whole group. With
   * the whole group in hand that is the printed rule word for word; with a
   * street unlocked by visits it is the only reading that means anything, since
   * the neighbour's houses are not yours to level up to.
   */
  #ownedInGroup(ownerId: string, groupId: string): number[] {
    return groupMembers(this.map, groupId).filter((i) => this.#holdings[i].owner === ownerId);
  }

  /** Count a landing on your own square, and hand back the new total. */
  #visit(playerId: string, index: number): number {
    const key = `${playerId}:${index}`;
    const n = (this.#visits.get(key) ?? 0) + 1;
    this.#visits.set(key, n);
    return n;
  }

  /**
   * Ask whether to build here, if there is anything to ask.
   *
   * Raised on landing rather than left to the estate panel, because that is the
   * change in the rule: a street you do not hold the whole colour group of can be
   * built on *only* at the moment you are standing on it, and the board asks you
   * then. `#upgradeAt` is what makes it legal — see `#buildBlock`.
   *
   * Everything the offer depends on is `#buildBlock`'s business, so the offer is
   * made by provisionally opening it and asking that one function. Nothing left
   * to decide means the turn carries on as it always did.
   */
  #offerUpgrade(seat: Seat, index: number): void {
    this.#upgradeAt = index;
    if (this.#buildBlock(seat, index)) {
      this.#upgradeAt = null;
      this.#afterLanding();
      return;
    }
    const space = this.map.spaces[index];
    const level = this.#holdings[index].level + 1;
    const what = level === MAX_HOUSES + 1 ? "khách sạn 🏨" : `nhà thứ ${level} 🏠`;
    this.#pending = { kind: "upgrade", space: index };
    this.#say(
      "🏗️",
      `${this.#nameOf(seat.id)} có thể xây ${what} ở ${space.icon} ${space.name} — ${
        this.money(space.house)
      }. Xây hay để sau?`,
      seat.id,
    );
    this.#touch();
  }

  /** Close the offer and get on with the turn. */
  #closeUpgrade(): void {
    this.#upgradeAt = null;
    this.#afterLanding();
  }

  /** Every place they hold, as indices. */
  #myPlaces(ownerId: string): number[] {
    return this.#holdings
      .map((h, i) => ({ h, i }))
      .filter(({ h, i }) => h.owner === ownerId && this.map.spaces[i].kind === "place")
      .map(({ i }) => i);
  }

  /**
   * The deed a card may move: unbuilt, unmortgaged, and the cheapest of those.
   *
   * Built and mortgaged deeds are left alone because moving one would mean
   * unwinding a building or a loan as a side effect of a card, and a card that
   * quietly liquidates half a colour group is not funny twice.
   */
  #loosestDeed(ownerId: string): number | undefined {
    return this.#holdings
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h.owner === ownerId && h.level === 0 && !h.mortgaged)
      .map(({ i }) => i)
      .sort((a, b) => this.map.spaces[a].price - this.map.spaces[b].price)[0];
  }

  /** Would one more building here keep the group even? */
  #evenBuildOk(ownerId: string, index: number): boolean {
    const mine = this.#ownedInGroup(ownerId, this.map.spaces[index].group);
    const lowest = Math.min(...mine.map((i) => this.#holdings[i].level));
    return this.#holdings[index].level + 1 <= lowest + 1;
  }

  /** Would selling one from here keep the group even? */
  #evenSellOk(ownerId: string, index: number): boolean {
    const mine = this.#ownedInGroup(ownerId, this.map.spaces[index].group);
    const highest = Math.max(...mine.map((i) => this.#holdings[i].level));
    return this.#holdings[index].level - 1 >= highest - 1;
  }

  /** Mortgage back plus interest — what it costs to get a deed out of hock. */
  #redeemCost(index: number): number {
    const raised = Math.floor(this.map.spaces[index].price / 2);
    return Math.ceil((raised * (100 + MORTGAGE_INTEREST_PERCENT)) / 100);
  }

  /**
   * Why this square cannot take another building, or null if it can.
   *
   * One function rather than a run of throws inside `build`, because the same
   * question gets asked three more times: to grey out a button, to decide
   * whether the tail of a turn is worth stopping on, and to build for somebody
   * who has walked away from their screen.
   */
  #buildBlock(seat: Seat, index: number): { code: string; message: string } | null {
    const space = this.map.spaces[index];
    const holding = this.#holdings[index];
    if (!space || space.kind !== "place") {
      return { code: "notBuildable", message: "Chỉ xây được trên ô địa điểm." };
    }
    if (holding.owner !== seat.id) {
      return { code: "notYours", message: "Ô này không phải của bạn." };
    }
    if (holding.mortgaged) return { code: "mortgaged", message: "Ô này đang thế chấp." };
    if (holding.level >= MAX_HOUSES + 1) {
      return { code: "full", message: "Ô này đã có khách sạn." };
    }
    // The printed rule is the whole colour group or nothing, which in a game
    // where nobody completes a group means nobody ever builds and the second half
    // of Monopoly never happens. The second way in is the square itself: land on
    // your own street and the board asks you there and then. Away from it, a
    // partial group cannot be built on at all — the offer *is* the permission.
    if (!this.#ownsGroup(seat.id, space.group) && this.#upgradeAt !== index) {
      return {
        code: "noGroup",
        message: "Chưa đủ cả nhóm màu — chỉ xây được đúng lúc bạn ghé lại ô này, " +
          "khi bàn hỏi.",
      };
    }
    const mine = this.#ownedInGroup(seat.id, space.group);
    if (mine.some((i) => this.#holdings[i].mortgaged)) {
      return { code: "mortgaged", message: "Trong nhóm còn ô của bạn đang thế chấp." };
    }
    const lowest = Math.min(...mine.map((i) => this.#holdings[i].level));
    if (holding.level + 1 > lowest + 1) {
      return { code: "uneven", message: "Phải xây đều: xây ô thấp nhất trong nhóm trước." };
    }
    if (seat.cash < space.house) {
      return { code: "poor", message: `Cần ${this.money(space.house)} để xây.` };
    }
    return null;
  }

  /** Nothing left to decide on this square: either roll again, or wrap up. */
  #afterLanding(): void {
    if (this.#doubles > 0 && !this.#current.inJail) {
      this.#pending = { kind: "roll" };
      this.#touch();
      return;
    }
    this.#pending = { kind: "end" };
    // Most turns have nothing left in them: the rent was paid, or the square was
    // somebody's garden. Stopping there to make the player press "kết thúc lượt"
    // is a click that carries no information, and with four people round a table
    // it is the click all three of the others are waiting on. So the turn only
    // stops here when there is something to stop for.
    if (!this.#endWorthStopping(this.#current)) {
      this.#endTurnInternal();
      return;
    }
    this.#touch();
  }

  /**
   * Is the tail of this turn worth pausing on?
   *
   * True when they could put up a building they can afford, redeem a deed, or
   * answer an offer already on the table. Proposing a *new* deal is not counted:
   * an offer somebody might think of is not a reason to hold up three other
   * people, and the estate panel is still there on their next turn.
   */
  #endWorthStopping(seat: Seat): boolean {
    if (this.#trades.some((t) => t.toId === seat.id)) return true;
    return this.#holdings.some((h, i) => {
      if (h.owner !== seat.id) return false;
      if (h.mortgaged) return seat.cash >= this.#redeemCost(i);
      return this.map.spaces[i].kind === "place" && !this.#buildBlock(seat, i);
    });
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  /**
   * Draw one card, and do what it says.
   *
   * The two decks are not drawn the same way, on purpose. **Cơ hội** is the
   * printed pile: shuffled once, stepped through in order, every card turning up
   * exactly once a lap. **Khí vận** is a lucky draw — a tier by weight and then a
   * card inside it — so the same card can come twice, the good ones stay rare,
   * and landing there is a moment rather than a small number. It was the dullest
   * square on the board and it is now the one people hope for.
   */
  #drawCard(seat: Seat, deck: "chance" | "chest"): void {
    const cards = this.map[deck];
    const card = deck === "chest" ? drawChestCard(cards, this.#random) : this.#nextInPile(cards);

    this.#cardNo++;
    this.#card = {
      deck,
      icon: card.icon,
      text: card.text,
      forId: seat.id,
      tier: deck === "chest" ? card.tier ?? DEFAULT_TIER : undefined,
      no: this.#cardNo,
    };
    const heading = deck === "chance" ? "Cơ hội" : "Khí vận";
    const tier = deck === "chest"
      ? CHEST_TIERS.find((t) => t.id === (card.tier ?? DEFAULT_TIER))
      : undefined;
    this.#say(
      card.icon,
      `${this.#nameOf(seat.id)} rút ${heading}${
        tier ? ` ${tier.icon} ${tier.name}` : ""
      }: ${card.text}`,
      seat.id,
    );
    this.#applyCard(seat, card.effect);
  }

  /** The next card off the shuffled pile, wrapping round. */
  // deno-lint-ignore no-explicit-any
  #nextInPile(cards: any[]): any {
    const pile = this.#chance;
    const card = cards[pile[this.#chanceAt % pile.length]];
    this.#chanceAt = (this.#chanceAt + 1) % pile.length;
    return card;
  }

  #applyCard(seat: Seat, effect: { k: string; [key: string]: unknown }): void {
    switch (effect.k) {
      case "cash": {
        const amount = Number(effect.amount) || 0;
        if (amount >= 0) {
          this.#pay(seat, amount, "thẻ");
          this.#afterLanding();
        } else {
          this.#charge(seat, -amount, null, "phí theo thẻ");
          if (this.#pending.kind !== "debt") this.#afterLanding();
        }
        return;
      }

      case "each": {
        const amount = Number(effect.amount) || 0;
        const others = this.#living().filter((s) => s.id !== seat.id);
        if (amount >= 0) {
          // Everybody pays you. Anybody who cannot afford it owes it, one at a
          // time — so this can leave somebody else in debt, not the card holder.
          for (const other of others) this.#charge(other, amount, seat.id, "thẻ");
        } else {
          const owed = -amount * others.length;
          this.#charge(seat, owed, null, "thẻ");
          if (this.#pending.kind !== "debt") {
            for (const other of others) this.#pay(other, -amount, "thẻ");
          }
        }
        if (this.#pending.kind !== "debt") this.#afterLanding();
        return;
      }

      case "toGo":
        seat.pos = goSlot(this.map);
        this.#collectSalary(seat, false);
        this.#afterLanding();
        return;

      case "toRank": {
        const ranked = placesByRank(this.map);
        const target = ranked[Math.min(Number(effect.rank) || 0, ranked.length - 1)];
        this.#moveTo(seat, target, true);
        return;
      }

      case "back": {
        const steps = Number(effect.steps) || 3;
        const size = this.map.spaces.length;
        this.#moveTo(seat, (seat.pos - steps + size) % size, false);
        return;
      }

      case "jail":
        this.#sendToJail(seat);
        return;

      case "freeJail":
        seat.jailCards++;
        this.#afterLanding();
        return;

      case "nearest": {
        const kind = effect.target === "utility" ? "utility" : "transport";
        const target = nearestOfKind(this.map, seat.pos, kind);
        const size = this.map.spaces.length;
        const go = goSlot(this.map);
        // Walked, not teleported, so passing GO on the way still pays.
        const steps = (target - seat.pos + size) % size || size;
        for (let n = 0; n < steps; n++) {
          seat.pos = (seat.pos + 1) % size;
          if (seat.pos === go) this.#collectSalary(seat, false);
        }
        this.#land(seat, { factor: Number(effect.factor) || 2, kind });
        return;
      }

      case "nudge": {
        const steps = Math.max(1, Number(effect.steps) || 1);
        const size = this.map.spaces.length;
        const go = goSlot(this.map);
        // On foot, so passing Xuất phát on the way still pays — and so the piece
        // walks it on both boards.
        for (let n = 0; n < steps; n++) {
          seat.pos = (seat.pos + 1) % size;
          if (seat.pos === go) this.#collectSalary(seat, false);
        }
        this.#land(seat);
        return;
      }

      case "jackpot": {
        const fallback = Math.max(0, Number(effect.amount) || 0);
        if (this.rules.parkingPot && this.#pot > 0) {
          const won = this.#pot;
          this.#pot = 0;
          this.#pay(seat, won, "hũ giữa bàn");
          this.#say(
            "🎰",
            `${this.#nameOf(seat.id)} vét sạch hũ giữa bàn: ${this.money(won)}!`,
            seat.id,
          );
        } else if (fallback > 0) {
          this.#pay(seat, fallback, "thẻ");
        }
        this.#afterLanding();
        return;
      }

      case "shield": {
        seat.shields++;
        this.#say(
          "🛡️",
          `${this.#nameOf(seat.id)} được bảo kê — lần tới phải trả tiền thuê thì miễn.`,
          seat.id,
        );
        this.#afterLanding();
        return;
      }

      case "freeBuild": {
        // The cheapest place they hold that can take another storey, ignoring the
        // group rule and the price — that is what makes it the jackpot. Even
        // build is still respected: a free house that broke the rule the rest of
        // the game enforces would be a bug wearing a card's clothes.
        const target = this.#myPlaces(seat.id)
          .filter((i) =>
            !this.#holdings[i].mortgaged &&
            this.#holdings[i].level < MAX_HOUSES + 1 &&
            this.#evenBuildOk(seat.id, i)
          )
          .sort((a, b) => this.map.spaces[a].price - this.map.spaces[b].price)[0];
        if (target === undefined) {
          this.#say("🏗️", `${this.#nameOf(seat.id)} chưa có ô nào để xây — phiếu này bỏ trống.`);
          this.#afterLanding();
          return;
        }
        const space = this.map.spaces[target];
        this.#holdings[target].level++;
        this.#manageNo++;
        const level = this.#holdings[target].level;
        this.#say(
          "🏗️",
          `${this.#nameOf(seat.id)} được xây miễn phí ${
            level === MAX_HOUSES + 1 ? "khách sạn 🏨" : `nhà thứ ${level} 🏠`
          } ở ${space.icon} ${space.name}.`,
          seat.id,
        );
        this.#afterLanding();
        return;
      }

      case "sellBuilding": {
        const target = this.#myPlaces(seat.id)
          .filter((i) => this.#holdings[i].level > 0 && this.#evenSellOk(seat.id, i))
          .sort((a, b) => this.#holdings[b].level - this.#holdings[a].level)[0];
        if (target === undefined) {
          this.#say("🧨", `${this.#nameOf(seat.id)} chưa xây gì — không có gì phải phá.`);
          this.#afterLanding();
          return;
        }
        const space = this.map.spaces[target];
        const refund = Math.floor(space.house / 2);
        this.#holdings[target].level--;
        this.#manageNo++;
        this.#pay(seat, refund, "giải toả");
        this.#say(
          "🧨",
          `${this.#nameOf(seat.id)} phải phá một công trình ở ${space.icon} ${space.name}, ` +
            `được đền ${this.money(refund)}.`,
          seat.id,
        );
        this.#afterLanding();
        return;
      }

      case "giveDeed": {
        const to = this.#living()
          .filter((s) => s.id !== seat.id)
          .sort((a, b) => this.net(a) - this.net(b))[0];
        const deed = this.#loosestDeed(seat.id);
        if (!to || deed === undefined) {
          this.#say("🎁", `${this.#nameOf(seat.id)} không có gì trao được — phiếu này bỏ trống.`);
          this.#afterLanding();
          return;
        }
        const space = this.map.spaces[deed];
        this.#holdings[deed].owner = to.id;
        this.#say(
          "🎁",
          `${this.#nameOf(seat.id)} trao ${space.icon} ${space.name} cho ${
            this.#nameOf(to.id)
          } — nghĩa tình khu phố.`,
          seat.id,
        );
        this.#afterLanding();
        return;
      }

      case "swapDeed": {
        const rich = this.#living()
          .filter((s) => s.id !== seat.id)
          .sort((a, b) => this.net(b) - this.net(a))[0];
        const mine = this.#loosestDeed(seat.id);
        const theirs = rich ? this.#loosestDeed(rich.id) : undefined;
        if (!rich || mine === undefined || theirs === undefined) {
          this.#say("🔄", `Không đủ giấy tờ trống để đổi — phiếu này bỏ trống.`);
          this.#afterLanding();
          return;
        }
        this.#holdings[mine].owner = rich.id;
        this.#holdings[theirs].owner = seat.id;
        this.#say(
          "🔄",
          `${this.#nameOf(seat.id)} đổi ${this.map.spaces[mine].icon} ${
            this.map.spaces[mine].name
          } lấy ${this.map.spaces[theirs].icon} ${this.map.spaces[theirs].name} của ${
            this.#nameOf(rich.id)
          }.`,
          seat.id,
        );
        this.#afterLanding();
        return;
      }

      case "repairs": {
        let houses = 0;
        let hotels = 0;
        this.#holdings.forEach((h) => {
          if (h.owner !== seat.id) return;
          if (h.level === 5) hotels++;
          else houses += h.level;
        });
        const owed = houses * (Number(effect.house) || 0) + hotels * (Number(effect.hotel) || 0);
        if (owed > 0) {
          this.#say(
            "🧱",
            `${this.#nameOf(seat.id)} có ${houses} nhà và ${hotels} khách sạn — trả ${
              this.money(owed)
            }.`,
            seat.id,
          );
          this.#charge(seat, owed, null, "sửa chữa");
        }
        if (this.#pending.kind !== "debt") this.#afterLanding();
        return;
      }

      default:
        this.#afterLanding();
    }
  }

  // -------------------------------------------------------------------------
  // Buying, and the auction that follows a refusal
  // -------------------------------------------------------------------------

  buy(playerId: string): void {
    const seat = this.#requireTurn(playerId, ["buy"]);
    const index = (this.#pending as { space: number }).space;
    const space = this.map.spaces[index];
    if (seat.cash < space.price) {
      throw new MonopolyError(
        "poor",
        `Không đủ tiền: ${space.name} giá ${this.money(space.price)}, bạn có ${
          this.money(seat.cash)
        }.`,
      );
    }
    seat.cash -= space.price;
    this.#holdings[index].owner = seat.id;
    this.#say(
      "🤝",
      `${this.#nameOf(seat.id)} mua ${space.icon} ${space.name} với ${this.money(space.price)}.`,
      seat.id,
    );
    this.#afterLanding();
  }

  /** Pass on a square. Under the printed rules that opens an auction. */
  decline(playerId: string): void {
    const seat = this.#requireTurn(playerId, ["buy"]);
    const index = (this.#pending as { space: number }).space;
    const space = this.map.spaces[index];

    if (!this.rules.auction) {
      this.#say("🙅", `${this.#nameOf(seat.id)} bỏ qua ${space.icon} ${space.name}.`, seat.id);
      this.#afterLanding();
      return;
    }
    const bidders = this.#living().map((s) => s.id);
    if (bidders.length < 2) {
      this.#say("🙅", `${this.#nameOf(seat.id)} bỏ qua ${space.icon} ${space.name}.`, seat.id);
      this.#afterLanding();
      return;
    }
    this.#auction = { space: index, high: 0, highId: null, active: new Set(bidders) };
    this.#say(
      "🔨",
      `${this.#nameOf(seat.id)} không mua — ${space.icon} ${space.name} lên sàn đấu giá. ` +
        `Ai cũng được trả giá.`,
    );
    this.#touch();
  }

  bid(playerId: string, amount: number): void {
    const auction = this.#auction;
    if (!auction) throw new MonopolyError("noAuction", "Không có phiên đấu giá nào.");
    const seat = this.#seat(playerId);
    if (seat.bankrupt || !auction.active.has(playerId)) {
      throw new MonopolyError("out", "Bạn đã rút khỏi phiên này.");
    }
    const bid = Math.round(Number(amount));
    if (!Number.isFinite(bid) || bid <= auction.high) {
      throw new MonopolyError("lowBid", `Phải trả cao hơn ${this.money(auction.high)}.`);
    }
    // Bid what you can pay. Bidding money you would have to mortgage for is a
    // real strategy in some houses, but it needs an unwind path we do not have.
    if (bid > seat.cash) {
      throw new MonopolyError("poor", `Bạn chỉ có ${this.money(seat.cash)} tiền mặt.`);
    }
    auction.high = bid;
    auction.highId = playerId;
    const space = this.map.spaces[auction.space];
    this.#say(
      "🔨",
      `${this.#nameOf(playerId)} trả ${this.money(bid)} cho ${space.name}.`,
      playerId,
    );
    this.#touch();
  }

  /** Drop out. When one bidder is left, or nobody is, the hammer falls. */
  withdrawBid(playerId: string): void {
    const auction = this.#auction;
    if (!auction) throw new MonopolyError("noAuction", "Không có phiên đấu giá nào.");
    if (!auction.active.has(playerId)) return;
    auction.active.delete(playerId);
    this.#say("🚪", `${this.#nameOf(playerId)} rút khỏi phiên đấu giá.`, playerId);

    const remaining = [...auction.active];
    // Settled when everybody but the leader has folded, or when the last two
    // both walked away and there is a standing bid to honour.
    if (
      auction.highId && remaining.length <= 1 &&
      (remaining.length === 0 || remaining[0] === auction.highId)
    ) {
      this.#settleAuction();
      return;
    }
    if (remaining.length === 0) {
      const space = this.map.spaces[auction.space];
      this.#say("🔨", `Không ai trả giá — ${space.icon} ${space.name} vẫn của ngân hàng.`);
      this.#auction = null;
      this.#afterLanding();
      return;
    }
    this.#touch();
  }

  #settleAuction(): void {
    const auction = this.#auction!;
    const space = this.map.spaces[auction.space];
    const winner = this.#seat(auction.highId!);
    winner.cash -= auction.high;
    this.#holdings[auction.space].owner = winner.id;
    this.#say(
      "🔨",
      `${this.#nameOf(winner.id)} thắng đấu giá ${space.icon} ${space.name} với ${
        this.money(auction.high)
      }.`,
      winner.id,
    );
    this.#auction = null;
    this.#afterLanding();
  }

  // -------------------------------------------------------------------------
  // Tax, jail
  // -------------------------------------------------------------------------

  payTax(playerId: string, how: "flat" | "percent"): void {
    const seat = this.#requireTurn(playerId, ["tax"]);
    const space = this.map.spaces[(this.#pending as { space: number }).space];
    const percentAmount = Math.round((this.net(seat) * (space.percent ?? 10)) / 100);
    const amount = how === "flat" ? space.amount : percentAmount;
    this.#say(
      "🧾",
      how === "flat"
        ? `${this.#nameOf(seat.id)} trả thuế gọn ${this.money(amount)}.`
        : `${this.#nameOf(seat.id)} trả ${space.percent}% tài sản: ${this.money(amount)}.`,
      seat.id,
    );
    this.#charge(seat, amount, null, "thuế thu nhập");
    if (this.#pending.kind !== "debt") this.#afterLanding();
  }

  /** Buy your way out, or spend the card. Rolling for it goes through `roll`. */
  leaveJail(playerId: string, how: "pay" | "card"): void {
    const seat = this.#requireTurn(playerId, ["jail", "roll"]);
    if (!seat.inJail) throw new MonopolyError("notInJail", "Bạn không ở trong tù.");
    if (how === "card") {
      if (seat.jailCards <= 0) throw new MonopolyError("noCard", "Bạn không có thẻ ra tù.");
      seat.jailCards--;
      seat.inJail = false;
      seat.jailTurns = 0;
      this.#say("🎫", `${this.#nameOf(seat.id)} dùng thẻ ra tù miễn phí.`, seat.id);
      this.#pending = { kind: "roll" };
      this.#touch();
      return;
    }
    const bail = this.map.money.bail as number;
    if (seat.cash < bail) {
      throw new MonopolyError(
        "poor",
        `Tiền bảo lãnh là ${this.money(bail)}, bạn có ${this.money(seat.cash)}.`,
      );
    }
    seat.cash -= bail;
    if (this.rules.parkingPot) this.#pot += bail;
    seat.inJail = false;
    seat.jailTurns = 0;
    this.#say("💸", `${this.#nameOf(seat.id)} nộp ${this.money(bail)} và ra tù.`, seat.id);
    this.#pending = { kind: "roll" };
    this.#touch();
  }

  // -------------------------------------------------------------------------
  // Building, mortgaging — legal at any time you are not mid-decision
  // -------------------------------------------------------------------------

  /**
   * Estate management is allowed whenever the game is waiting on *you*, and also
   * while you are in debt — that is exactly when a player needs to sell a hotel.
   */
  #requireManage(playerId: string): Seat {
    const seat = this.#seat(playerId);
    if (this.isOver) throw new MonopolyError("over", "Trận đã kết thúc.");
    if (seat.bankrupt) throw new MonopolyError("bankrupt", "Bạn đã phá sản.");
    if (this.#pending.kind === "debt") {
      if (this.#pending.who !== playerId) {
        throw new MonopolyError("waiting", `Đang chờ ${this.#nameOf(this.#pending.who)} trả nợ.`);
      }
      return seat;
    }
    return seat;
  }

  build(playerId: string, index: number): void {
    const seat = this.#requireManage(playerId);
    const blocked = this.#buildBlock(seat, index);
    if (blocked) throw new MonopolyError(blocked.code, blocked.message);
    const space = this.map.spaces[index];
    const holding = this.#holdings[index];
    seat.cash -= space.house;
    holding.level++;
    this.#manageNo++;
    const what = holding.level === MAX_HOUSES + 1 ? "khách sạn 🏨" : `nhà thứ ${holding.level} 🏠`;
    this.#say(
      "🏗️",
      `${this.#nameOf(seat.id)} xây ${what} ở ${space.icon} ${space.name} (${
        this.money(space.house)
      }).`,
      seat.id,
    );
    // Built off the offer the board raised on landing: ask again if there is
    // another storey to be had, and get on with the turn if there is not. A
    // player standing on their own street with the money for two houses should
    // not have to wait a lap for the second one.
    if (this.#upgradeAt === index && this.#pending.kind === "upgrade") {
      if (this.#buildBlock(seat, index)) {
        this.#closeUpgrade();
        return;
      }
    }
    this.#touch();
  }

  /**
   * Turn down the building the board just offered, and carry on.
   *
   * Closing the offer is what makes the street unbuildable again, so this is not
   * the same as leaving the question unanswered — which is why the machine
   * answers it for anybody who walks away mid-turn.
   */
  later(playerId: string): void {
    this.#requireTurn(playerId, ["upgrade"]);
    const index = (this.#pending as { space: number }).space;
    const space = this.map.spaces[index];
    this.#say(
      "👉",
      `${this.#nameOf(playerId)} để sau chuyện xây ở ${space.icon} ${space.name}.`,
      playerId,
    );
    this.#closeUpgrade();
  }

  /** Sell a building back to the bank at half what it cost. */
  sellBuilding(playerId: string, index: number): void {
    const seat = this.#requireManage(playerId);
    const space = this.map.spaces[index];
    const holding = this.#holdings[index];
    if (!space || space.kind !== "place" || holding.owner !== seat.id) {
      throw new MonopolyError("notYours", "Ô này không phải của bạn.");
    }
    if (holding.level <= 0) throw new MonopolyError("nothing", "Ở đây chưa có gì để bán.");
    const members = this.#ownedInGroup(seat.id, space.group);
    const highest = Math.max(...members.map((i) => this.#holdings[i].level));
    if (holding.level - 1 < highest - 1) {
      throw new MonopolyError("uneven", "Phải bán đều: bán ô cao nhất trong nhóm trước.");
    }
    const refund = Math.floor(space.house / 2);
    holding.level--;
    this.#manageNo++;
    seat.cash += refund;
    this.#say(
      "🧰",
      `${this.#nameOf(seat.id)} bán một công trình ở ${space.icon} ${space.name}, thu ${
        this.money(refund)
      }.`,
      seat.id,
    );
    this.#settleDebtIfCleared();
    this.#touch();
  }

  mortgage(playerId: string, index: number): void {
    const seat = this.#requireManage(playerId);
    const space = this.map.spaces[index];
    const holding = this.#holdings[index];
    if (!space || !isOwnable(space) || holding.owner !== seat.id) {
      throw new MonopolyError("notYours", "Ô này không phải của bạn.");
    }
    if (holding.mortgaged) throw new MonopolyError("already", "Ô này đã thế chấp.");
    if (space.kind === "place") {
      const members = this.#ownedInGroup(seat.id, space.group);
      if (members.some((i) => this.#holdings[i].level > 0)) {
        throw new MonopolyError("hasHouses", "Phải bán hết nhà trong nhóm trước khi thế chấp.");
      }
    }
    const raised = Math.floor(space.price / 2);
    holding.mortgaged = true;
    this.#manageNo++;
    seat.cash += raised;
    this.#say(
      "📄",
      `${this.#nameOf(seat.id)} thế chấp ${space.icon} ${space.name}, nhận ${this.money(raised)}.`,
      seat.id,
    );
    this.#settleDebtIfCleared();
    this.#touch();
  }

  unmortgage(playerId: string, index: number): void {
    const seat = this.#requireManage(playerId);
    const space = this.map.spaces[index];
    const holding = this.#holdings[index];
    if (!space || holding.owner !== seat.id) {
      throw new MonopolyError("notYours", "Ô này không phải của bạn.");
    }
    if (!holding.mortgaged) throw new MonopolyError("notMortgaged", "Ô này không bị thế chấp.");
    const cost = this.#redeemCost(index);
    if (seat.cash < cost) {
      throw new MonopolyError("poor", `Cần ${this.money(cost)} để giải chấp.`);
    }
    seat.cash -= cost;
    holding.mortgaged = false;
    this.#manageNo++;
    this.#say(
      "🧾",
      `${this.#nameOf(seat.id)} giải chấp ${space.icon} ${space.name} với ${this.money(cost)}.`,
      seat.id,
    );
    this.#touch();
  }

  // -------------------------------------------------------------------------
  // Debt and bankruptcy
  // -------------------------------------------------------------------------

  /** Called after any cash-raising move: has the hole been filled? */
  #settleDebtIfCleared(): void {
    if (this.#pending.kind !== "debt") return;
    const { who, amount, to } = this.#pending;
    const seat = this.#seat(who);
    if (seat.cash < amount) return;
    seat.cash -= amount;
    this.#credit(to, amount, "nợ");
    this.#say(
      "✅",
      `${this.#nameOf(who)} trả xong ${this.money(amount)}${to ? ` cho ${this.#nameOf(to)}` : ""}.`,
      who,
    );
    // The debt may have interrupted somebody else's turn — an "each player pays
    // you" card can bankrupt a bystander. `#afterLanding` resumes whoever is in
    // turn, which is the right answer either way.
    this.#afterLanding();
  }

  /**
   * Give up. Everything goes to whoever is owed, or back to the bank.
   *
   * Refused while they could still pay, because "I would rather not mortgage"
   * is not bankruptcy and letting it be one would hand players a way to dodge a
   * rent they can afford.
   */
  declareBankrupt(playerId: string): void {
    const seat = this.#requireTurn(playerId, ["debt"]);
    const debt = this.#pending as { amount: number; to: string | null };
    if (this.#liquid(seat) >= debt.amount) {
      throw new MonopolyError(
        "canPay",
        `Bạn vẫn còn đủ tài sản để trả ${this.money(debt.amount)} — bán nhà hoặc thế chấp.`,
      );
    }
    const creditor = debt.to;
    seat.bankrupt = true;
    const gone = this.#nameOf(seat.id);

    if (creditor) {
      const winner = this.#seat(creditor);
      winner.cash += seat.cash;
      // Buildings are always liquidated to the bank; the creditor takes deeds,
      // not houses, exactly as the printed rules have it.
      let refund = 0;
      this.#holdings.forEach((h, i) => {
        if (h.owner !== seat.id) return;
        refund += this.#sellBack(i, h.level);
        h.level = 0;
        h.owner = creditor;
      });
      winner.cash += refund;
      this.#say(
        "🏳️",
        `${gone} phá sản. Toàn bộ tiền và giấy tờ chuyển cho ${this.#nameOf(creditor)}.`,
        seat.id,
      );
    } else {
      this.#holdings.forEach((h) => {
        if (h.owner !== seat.id) return;
        h.owner = null;
        h.level = 0;
        h.mortgaged = false;
      });
      this.#say("🏳️", `${gone} phá sản. Tài sản trở về ngân hàng.`, seat.id);
    }
    seat.cash = 0;
    seat.jailCards = 0;
    seat.inJail = false;

    if (this.#checkWinner()) return;
    // If the bankrupt player was the one in turn, the turn moves on; if the debt
    // interrupted somebody else's turn, that turn resumes.
    if (this.#current.id === seat.id) this.#endTurnInternal();
    else this.#afterLanding();
  }

  #checkWinner(): boolean {
    const living = this.#living();
    if (living.length > 1) return false;
    this.#winnerId = living[0]?.id ?? null;
    this.#pending = { kind: "over" };
    if (this.#winnerId) {
      this.#say(
        "🏆",
        `${this.#nameOf(this.#winnerId)} là người cuối cùng còn trụ — thắng!`,
        this.#winnerId,
      );
    } else {
      this.#say("🏁", "Không còn ai trong bàn.");
    }
    this.#touch();
    return true;
  }

  /** End the game now and award it on net worth. Used when the host calls time. */
  callTime(): void {
    if (this.isOver) return;
    const living = this.#living();
    const ranked = [...living].sort((a, b) => this.net(b) - this.net(a));
    this.#winnerId = ranked[0]?.id ?? null;
    this.#pending = { kind: "over" };
    if (this.#winnerId) {
      this.#say(
        "🏆",
        `Kết thúc theo tài sản: ${this.#nameOf(this.#winnerId)} dẫn đầu với ${
          this.money(this.net(ranked[0]))
        }.`,
        this.#winnerId,
      );
    }
    this.#touch();
  }

  // -------------------------------------------------------------------------
  // Trading
  // -------------------------------------------------------------------------

  propose(
    fromId: string,
    toId: string,
    offer: { giveSpaces: number[]; giveCash: number; wantSpaces: number[]; wantCash: number },
  ): void {
    const from = this.#requireManage(fromId);
    const to = this.#seat(toId);
    if (to.bankrupt) throw new MonopolyError("bankrupt", "Người đó đã phá sản.");
    if (fromId === toId) throw new MonopolyError("self", "Không thể tự đổi với chính mình.");

    const giveSpaces = this.#checkTradeSide(from.id, offer.giveSpaces);
    const wantSpaces = this.#checkTradeSide(to.id, offer.wantSpaces);
    const giveCash = Math.max(0, Math.round(Number(offer.giveCash) || 0));
    const wantCash = Math.max(0, Math.round(Number(offer.wantCash) || 0));
    if (giveCash > from.cash) throw new MonopolyError("poor", "Bạn không có đủ tiền mặt để trả.");
    if (!giveSpaces.length && !wantSpaces.length && !giveCash && !wantCash) {
      throw new MonopolyError("empty", "Lời đề nghị trống.");
    }
    // One open offer per pair, so a rapid-fire proposer cannot bury somebody.
    this.#trades = this.#trades.filter((t) => !(t.fromId === fromId && t.toId === toId));
    this.#trades.push({
      id: `tr${++this.#tradeSeq}`,
      fromId,
      toId,
      giveSpaces,
      giveCash,
      wantSpaces,
      wantCash,
    });
    this.#manageNo++;
    this.#say(
      "🤝",
      `${this.#nameOf(fromId)} đề nghị đổi với ${this.#nameOf(toId)}.`,
      fromId,
    );
    this.#touch();
  }

  #checkTradeSide(ownerId: string, list: unknown): number[] {
    if (!Array.isArray(list)) return [];
    const out: number[] = [];
    for (const raw of list.slice(0, 28)) {
      const i = Math.round(Number(raw));
      const space = this.map.spaces[i];
      const holding = this.#holdings[i];
      if (!space || !holding || holding.owner !== ownerId) {
        throw new MonopolyError("notYours", "Trong danh sách có ô không thuộc người đó.");
      }
      // Houses cannot change hands. Sell them first, as at a real table.
      if (holding.level > 0) {
        throw new MonopolyError(
          "hasHouses",
          `${space.name} còn công trình — bán hết trước khi đổi.`,
        );
      }
      if (!out.includes(i)) out.push(i);
    }
    return out;
  }

  respond(playerId: string, tradeId: string, accept: boolean): void {
    const trade = this.#trades.find((t) => t.id === tradeId);
    if (!trade) throw new MonopolyError("noTrade", "Lời đề nghị đó không còn.");
    if (trade.toId !== playerId) {
      throw new MonopolyError("notYours", "Đề nghị này không dành cho bạn.");
    }
    this.#trades = this.#trades.filter((t) => t.id !== tradeId);
    this.#manageNo++;

    if (!accept) {
      this.#say("🙅", `${this.#nameOf(playerId)} từ chối lời đề nghị.`, playerId);
      this.#touch();
      return;
    }
    const from = this.#seat(trade.fromId);
    const to = this.#seat(trade.toId);
    // Re-checked at acceptance, not only at proposal: the board moved in between,
    // and a deal that was legal a minute ago may not be now.
    this.#checkTradeSide(from.id, trade.giveSpaces);
    this.#checkTradeSide(to.id, trade.wantSpaces);
    if (from.cash < trade.giveCash) {
      throw new MonopolyError("poor", "Bên đề nghị không còn đủ tiền.");
    }
    if (to.cash < trade.wantCash) {
      throw new MonopolyError("poor", `Bạn cần ${this.money(trade.wantCash)}.`);
    }

    for (const i of trade.giveSpaces) this.#holdings[i].owner = to.id;
    for (const i of trade.wantSpaces) this.#holdings[i].owner = from.id;
    from.cash -= trade.giveCash;
    to.cash += trade.giveCash;
    to.cash -= trade.wantCash;
    from.cash += trade.wantCash;
    this.#say(
      "✅",
      `${this.#nameOf(from.id)} và ${this.#nameOf(to.id)} đã đổi xong.`,
      to.id,
    );
    this.#settleDebtIfCleared();
    this.#touch();
  }

  // -------------------------------------------------------------------------
  // Ending a turn
  // -------------------------------------------------------------------------

  endTurn(playerId: string): void {
    this.#requireTurn(playerId, ["end"]);
    this.#endTurnInternal();
  }

  /**
   * "I am still here."
   *
   * The board plays a turn for whoever stops answering, which is what keeps a
   * table of five moving — but somebody weighing up a trade is thinking, not
   * gone. This restarts their clock and does nothing else. It goes through the
   * estate counter rather than touching `#waitAt`, so it is the same mechanism
   * that already stops a player being timed out mid-build.
   */
  hold(playerId: string): void {
    this.#requireManage(playerId);
    this.#manageNo++;
    this.#touch();
  }

  #endTurnInternal(): void {
    this.#doubles = 0;
    this.#dice = null;
    // The card deliberately outlives the turn, and is cleared by the next throw
    // instead. Since turns end themselves when nothing is left in them, a card
    // that only pays out cash used to be drawn, applied and wiped inside one
    // synchronous call — so nobody ever saw it, and the only trace was a line in
    // the feed. It now stays on the table until somebody picks up the dice.
    // Offers do not survive the turn that made them; a stale deal on the table
    // three turns later is a trap rather than an offer.
    this.#trades = [];
    if (this.#checkWinner()) return;

    const size = this.#seats.length;
    for (let step = 1; step <= size; step++) {
      const next = (this.#turn + step) % size;
      if (this.#seats[next].bankrupt) continue;
      if (next <= this.#turn) this.#round++;
      this.#turn = next;
      break;
    }
    const seat = this.#current;
    this.#pending = seat.inJail ? { kind: "jail" } : { kind: "roll" };
    this.#say("➡️", `Tới lượt ${this.#nameOf(seat.id)}.`, seat.id);
    this.#touch();
  }

  /**
   * Host: move past somebody who is not there.
   *
   * Only for a player whose browser is gone — a host who could skip a live
   * opponent could simply skip them out of the game.
   */
  skip(actorId: string, hostId: string): void {
    if (actorId !== hostId) throw new MonopolyError("notHost", "Chỉ chủ phòng làm được việc này.");
    if (this.isOver) throw new MonopolyError("over", "Trận đã kết thúc.");
    const waitingOn = this.#pending.kind === "debt" ? this.#pending.who : this.#current.id;
    if (this.#deps.connected(waitingOn)) {
      throw new MonopolyError("present", `${this.#nameOf(waitingOn)} vẫn đang kết nối.`);
    }
    if (this.#pending.kind === "debt") {
      // Their turn cannot be waited out, so the bank takes what it is owed and
      // they leave the game rather than freezing it.
      const seat = this.#seat(waitingOn);
      const debt = this.#pending;
      this.#say(
        "⏭️",
        `${this.#nameOf(waitingOn)} mất kết nối khi đang mắc nợ — xử phá sản.`,
        waitingOn,
      );
      seat.bankrupt = true;
      const creditor = debt.to;
      if (creditor) {
        const winner = this.#seat(creditor);
        winner.cash += seat.cash;
        this.#holdings.forEach((h, i) => {
          if (h.owner !== seat.id) return;
          winner.cash += this.#sellBack(i, h.level);
          h.level = 0;
          h.owner = creditor;
        });
      } else {
        this.#holdings.forEach((h) => {
          if (h.owner !== seat.id) return;
          h.owner = null;
          h.level = 0;
          h.mortgaged = false;
        });
      }
      seat.cash = 0;
      if (this.#checkWinner()) return;
      this.#endTurnInternal();
      return;
    }
    this.#say("⏭️", `Bỏ lượt của ${this.#nameOf(waitingOn)} — mất kết nối.`, waitingOn);
    this.#endTurnInternal();
  }

  /** Somebody walked out for good. Treated as a bank bankruptcy. */
  removePlayer(playerId: string): void {
    const seat = this.#seats.find((s) => s.id === playerId);
    if (!seat || seat.bankrupt) return;
    seat.bankrupt = true;
    seat.cash = 0;
    this.#holdings.forEach((h) => {
      if (h.owner !== playerId) return;
      h.owner = null;
      h.level = 0;
      h.mortgaged = false;
    });
    this.#trades = this.#trades.filter((t) => t.fromId !== playerId && t.toId !== playerId);
    if (this.#auction) {
      this.#auction.active.delete(playerId);
      if (this.#auction.highId === playerId) {
        this.#auction.highId = null;
        this.#auction.high = 0;
      }
    }
    this.#say("🚪", `${this.#nameOf(playerId)} rời bàn — tài sản về ngân hàng.`, playerId);
    if (this.#checkWinner()) return;
    if (this.#pending.kind === "debt" && this.#pending.who === playerId) this.#endTurnInternal();
    else if (this.#current.id === playerId) this.#endTurnInternal();
    else this.#touch();
  }

  // -------------------------------------------------------------------------
  // Waiting, and playing for somebody who is not there
  // -------------------------------------------------------------------------

  /** Is this player sitting at the table, as opposed to watching it? */
  hasSeat(playerId: string): boolean {
    return this.#seats.some((s) => s.id === playerId);
  }

  /** Everybody who was dealt in, in turn order. */
  seatIds(): string[] {
    return this.#seats.map((s) => s.id);
  }

  /** Who the board is waiting on. Null during an auction, which waits on all. */
  waitingOn(): string | null {
    if (this.isOver || this.#auction) return null;
    return this.#pending.kind === "debt" ? this.#pending.who : this.#current.id;
  }

  /**
   * Everybody the board cannot move on without.
   *
   * One player, almost always. An auction is the exception and it is the reason
   * this exists: the hammer cannot fall until every bidder has either raised or
   * walked away, so an auction waits on all of them at once and `waitingOn` has
   * nobody to name. Anything that answers for absent players has to read this
   * one rather than that one, or an auction is a wait nothing can end.
   */
  waitingIds(): string[] {
    if (this.isOver) return [];
    if (this.#auction) return [...this.#auction.active];
    const one = this.waitingOn();
    return one ? [one] : [];
  }

  /**
   * When the machine should answer for whoever it is waiting on.
   *
   * Two fuses, because the two waits are not the same. A decision only they can
   * make is worth the full twenty seconds. The tail of a turn is not: the only
   * thing left there is to say "done", and everybody else is watching a screen
   * where nothing happens.
   */
  autoDeadline(): number | null {
    if (this.waitingIds().length === 0) return null;
    // An auction gets the long fuse whatever the turn underneath it was in the
    // middle of: `pending` is still whatever it was before the square went up,
    // and reading it here would put a twelve-second clock on a decision that
    // has nothing to do with the end of anybody's turn.
    if (this.#auction) return this.#waitAt + AUTO_IDLE_MS;
    return this.#waitAt + (this.#pending.kind === "end" ? AUTO_END_MS : AUTO_IDLE_MS);
  }

  /**
   * Play one move for somebody who is not answering.
   *
   * Deliberately dull. It takes the cheap option, keeps a cushion of cash, and
   * never bids, never proposes a deal and never mortgages anything it is not
   * forced to. The point is to keep the table moving, not to play well with
   * somebody else's money — a machine that made bold choices on your behalf
   * would be worse than the wait it saves.
   *
   * Returns false when there was nothing for it to answer, so the caller can
   * stop arming a timer that will never fire.
   */
  autoMove(playerId: string): boolean {
    // An auction first, because it is the one wait that is not the turn's. It was
    // also the one wait nothing could answer: the machine read `waitingOn`,
    // which is null while the hammer is up, so a single absent bidder stopped
    // the table dead at the first refused square and no clock was running.
    //
    // It withdraws. Withdrawing never spends money nobody is watching, and it is
    // the only answer that always ends an auction — two machines raising each
    // other would never stop.
    if (this.#auction) {
      if (!this.#auction.active.has(playerId)) return false;
      this.withdrawBid(playerId);
      return true;
    }
    if (this.waitingOn() !== playerId) return false;
    const seat = this.#seat(playerId);
    const pending = this.#pending;
    switch (pending.kind) {
      case "roll":
        this.roll(playerId);
        return true;
      case "jail": {
        const bail = this.map.money.bail as number;
        // A card costs nothing, so spend it. Cash only when there is plenty:
        // sitting three turns out is free, and being broke outside is not.
        if (seat.jailCards > 0) this.leaveJail(playerId, "card");
        else if (seat.cash >= bail * 4) this.leaveJail(playerId, "pay");
        else this.roll(playerId);
        return true;
      }
      case "buy": {
        const price = this.map.spaces[pending.space].price as number;
        // Buy while a rainy-day fund survives it. An absent player left with no
        // cash goes bankrupt to the first rent they land on.
        const reserve = Math.floor((this.map.money.start as number) / 6);
        if (seat.cash - price >= reserve) this.buy(playerId);
        else this.decline(playerId);
        return true;
      }
      case "upgrade": {
        // Building for somebody who is not there is spending their money on a
        // judgement call, so it does not: it says later, which costs them the
        // chance and nothing else. The exception is the case where the printed
        // rules would let them build any time anyway — a complete colour group —
        // where a house is simply the right move and the money is spare.
        const space = this.map.spaces[pending.space];
        const reserve = Math.floor((this.map.money.start as number) / 3);
        if (
          this.#ownsGroup(seat.id, space.group) &&
          seat.cash - (space.house as number) >= reserve
        ) {
          this.build(playerId, pending.space);
          if (this.#pending.kind === "upgrade") this.later(playerId);
        } else {
          this.later(playerId);
        }
        return true;
      }
      case "tax": {
        const space = this.map.spaces[pending.space];
        const percent = Math.round((this.net(seat) * (space.percent ?? 10)) / 100);
        this.payTax(playerId, percent < (space.amount as number) ? "percent" : "flat");
        return true;
      }
      case "debt":
        this.#autoRaise(seat, pending.amount);
        return true;
      case "end":
        this.endTurn(playerId);
        return true;
      default:
        return false;
    }
  }

  /**
   * Raise what is owed the way a player would: buildings first, then deeds.
   *
   * Buildings go before mortgages because a sold house can be rebuilt and a
   * mortgaged street costs 10% to get back, and the cheapest deeds go first so
   * the streets worth holding are the ones still held at the end of it. Only
   * declares bankruptcy when there is genuinely nothing left, which is the same
   * test `declareBankrupt` applies anyway.
   */
  #autoRaise(seat: Seat, amount: number): void {
    let guard = 0;
    while (this.#pending.kind === "debt" && seat.cash < amount && guard++ < 200) {
      const sellable = this.#holdings
        .map((h, i) => ({ h, i }))
        .filter(({ h, i }) => {
          if (h.owner !== seat.id || h.level <= 0) return false;
          const mine = this.#ownedInGroup(seat.id, this.map.spaces[i].group);
          const highest = Math.max(...mine.map((j) => this.#holdings[j].level));
          return h.level - 1 >= highest - 1;
        })
        .sort((a, b) => b.h.level - a.h.level)[0];
      if (sellable) {
        this.sellBuilding(seat.id, sellable.i);
        continue;
      }
      const deed = this.#holdings
        .map((h, i) => ({ h, i }))
        .filter(({ h }) => h.owner === seat.id && !h.mortgaged && h.level === 0)
        .sort((a, b) => this.map.spaces[a.i].price - this.map.spaces[b.i].price)[0];
      if (!deed) break;
      this.mortgage(seat.id, deed.i);
    }
    if (this.#pending.kind === "debt" && this.#pending.who === seat.id) {
      this.declareBankrupt(seat.id);
    }
  }

  // -------------------------------------------------------------------------
  // The view
  // -------------------------------------------------------------------------

  view(): MonopolyView {
    const spaces: MonoSpaceView[] = this.map.spaces.map((space: Board, i: number) => {
      const holding = this.#holdings[i];
      const view: MonoSpaceView = {
        i,
        kind: space.kind,
        name: space.name,
        icon: space.icon,
        note: space.note ?? "",
        scene: space.scene ?? "",
      };
      if (space.group) view.group = space.group;
      if (space.price !== undefined) view.price = space.price;
      if (space.house !== undefined) view.houseCost = space.house;
      if (space.amount !== undefined) view.amount = space.amount;
      if (space.percent !== undefined) view.percent = space.percent;
      if (isOwnable(space)) {
        view.ownerId = holding.owner;
        view.level = holding.level;
        view.mortgaged = holding.mortgaged;
        // What it would cost to land here right now, so the panel can say so
        // without the browser reimplementing the rent rules.
        if (holding.owner && !holding.mortgaged) view.rent = this.#rentFor(i);
        if (space.kind === "place" && holding.owner) {
          // Answered here for the same reason `rent` is: the whole colour group or
          // else standing on it when asked, even build across the part of the
          // group they hold, no mortgages and enough cash is five rules, and a
          // browser that reimplemented them to grey out one button would be five
          // chances to disagree with us.
          const owner = this.#seats.find((s) => s.id === holding.owner);
          const blocked = owner ? this.#buildBlock(owner, i) : null;
          view.canBuild = Boolean(owner) && !blocked;
          if (blocked) view.buildNote = blocked.message;
        }
      }
      return view;
    });

    const players: MonoPlayerView[] = this.#seats.map((seat) => ({
      id: seat.id,
      token: seat.token,
      order: seat.order,
      hue: seat.hue,
      cash: seat.cash,
      pos: seat.pos,
      inJail: seat.inJail,
      jailTurns: seat.jailTurns,
      jailCards: seat.jailCards,
      shields: seat.shields,
      bankrupt: seat.bankrupt,
      net: this.net(seat),
    }));

    const auction: MonoAuctionView | null = this.#auction
      ? {
        space: this.#auction.space,
        high: this.#auction.high,
        highId: this.#auction.highId,
        activeIds: [...this.#auction.active],
      }
      : null;

    const trades: MonoTradeView[] = this.#trades.map((t) => ({ ...t }));

    return {
      map: {
        id: this.map.id,
        name: this.map.name,
        icon: this.map.icon,
        region: this.map.region,
        note: this.map.note,
        scene: this.map.scene ?? "",
        money: this.map.money,
        groups: this.map.groups,
      },
      spaces,
      players,
      turnId: this.isOver ? null : this.#current.id,
      dice: this.#dice,
      rollNo: this.#rollNo,
      doubles: this.#doubles,
      pending: this.#pendingView(),
      auction,
      trades,
      card: this.#card,
      waitingOn: this.waitingOn(),
      waitAt: this.#waitAt,
      autoAt: this.autoDeadline(),
      // Filled in by the room, which is where "who asked for this" lives. The
      // game knows the rules; it does not know who is at their keyboard.
      autoIds: [],
      restart: null,
      pot: this.rules.parkingPot ? this.#pot : null,
      round: this.#round,
      winnerId: this.#winnerId,
      rules: this.rules,
    };
  }

  #pendingView(): MonoPendingView {
    const p = this.#pending;
    switch (p.kind) {
      case "buy": {
        const space = this.map.spaces[p.space];
        return { kind: "buy", playerId: this.#current.id, space: p.space, price: space.price };
      }
      case "upgrade": {
        const space = this.map.spaces[p.space];
        return {
          kind: "upgrade",
          playerId: this.#current.id,
          space: p.space,
          buildCost: space.house,
          level: this.#holdings[p.space].level + 1,
        };
      }
      case "tax": {
        const space = this.map.spaces[p.space];
        return {
          kind: "tax",
          playerId: this.#current.id,
          space: p.space,
          flat: space.amount,
          percentAmount: Math.round((this.net(this.#current) * (space.percent ?? 10)) / 100),
        };
      }
      case "debt":
        return { kind: "debt", playerId: p.who, amount: p.amount, toId: p.to };
      case "jail":
        return {
          kind: "jail",
          playerId: this.#current.id,
          bail: this.map.money.bail,
          cards: this.#current.jailCards,
          turns: this.#current.jailTurns,
        };
      case "over":
        return { kind: "over", playerId: "" };
      default:
        return { kind: p.kind, playerId: this.#current.id };
    }
  }
}

/** What to say when somebody acts at the wrong moment. */
const PENDING_COMPLAINT: Record<Pending["kind"], string> = {
  roll: "Tung xúc xắc trước đã.",
  jail: "Bạn đang ở trong tù — nộp tiền, dùng thẻ, hoặc tung đôi.",
  buy: "Quyết định mua hay bỏ ô này trước.",
  upgrade: "Trả lời chuyện xây ở ô bạn đang đứng trước đã.",
  tax: "Chọn cách trả thuế trước.",
  debt: "Có người đang mắc nợ, chờ họ xử lý xong.",
  end: "Lượt này đã xong — kết thúc lượt hoặc quản lý tài sản.",
  over: "Trận đã kết thúc.",
};

/** Which payments to the bank land in the middle under the house rule. */
const FINES_TO_POT = new Set([
  "thuế thu nhập",
  "thuế xa xỉ",
  "phí theo thẻ",
  "sửa chữa",
  "tiền bảo lãnh",
]);
