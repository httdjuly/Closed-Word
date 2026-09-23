// Rules tests for the board game.
//
// These drive MonopolyGame directly rather than through a Room: the rules are
// where the bugs are, and the engine needs no ranker, no pack and no sockets.
// Room-level behaviour — who may start it, how many may sit down, loading a map
// — is at the bottom, where a Room is actually the thing under test.
//
// The dice are scripted. `h.roll(4, 3)` queues those two faces and takes the
// turn, so every test below is a fixed sequence of squares rather than a
// simulation that happens to pass.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { MAX_MONOPOLY_PLAYERS, MonopolyError, MonopolyGame } from "../server/monopoly.ts";
import { RoomError } from "../server/room.ts";
import {
  AUTO_IDLE_MS,
  CHEST_CARDS,
  CHEST_TIERS,
  drawChestCard,
  normaliseMap,
  ringPosition,
} from "../shared/monopoly.js";
import { SCENES } from "../shared/monopoly_art.js";
import { BUILTIN_MAP_IDS, builtinMap } from "../shared/monopoly_maps.js";
import { idFor, makeRoom } from "./helpers.ts";

// ---------------------------------------------------------------------------
// A board built for testing
//
// Two dice cannot roll a 1, so adjacent squares are unreachable in sequence and
// no scripted route can collect a colour group on the real board without a full
// lap per deed. This map spreads one group across 2, 6 and 9 — steps of 2, 4 and
// 3 from Xuất phát — so a player can buy all three in a single turn off two
// doubles, and the group rules become testable in four lines.
// ---------------------------------------------------------------------------

function testMap() {
  // Filler is a nil-rate tax rather than a parking square: with the
  // middle-of-the-board house rule on, every parking square collects the pot, so
  // a board made of them would hand the kitty to the first player to move.
  const spaces: Record<string, unknown>[] = Array.from({ length: 40 }, (_, i) => ({
    kind: "tax",
    name: `Ô trống ${i}`,
    icon: "▫️",
    amount: 0,
  }));

  const place = (
    i: number,
    name: string,
    group: string,
    price: number,
    rent: number[],
    house: number,
  ) => {
    spaces[i] = { kind: "place", name, icon: "📍", group, price, rent, house } as never;
  };

  spaces[0] = { kind: "go", name: "Xuất phát", icon: "🏁" };
  spaces[10] = { kind: "jail", name: "Tạm giam", icon: "🚔" };
  spaces[30] = { kind: "gotojail", name: "Vào tù ngay", icon: "👮" };

  // The group under test: cheap, three members, reachable in one turn.
  place(2, "Ngõ Một", "g0", 100, [10, 50, 150, 450, 625, 750], 50);
  place(6, "Ngõ Hai", "g0", 100, [10, 50, 150, 450, 625, 750], 50);
  place(9, "Ngõ Ba", "g0", 100, [10, 50, 150, 450, 625, 750], 50);
  // A two-member group, for testing that a partial group does not double.
  place(16, "Phố Bốn", "g1", 200, [20, 100, 300, 900, 1250, 1500], 100);
  place(19, "Phố Năm", "g1", 200, [20, 100, 300, 900, 1250, 1500], 100);
  // Filler, only to clear the "a board needs at least 8 places" check.
  place(21, "Hẻm Sáu", "g2", 60, [4, 20, 60, 180, 320, 450], 50);
  place(24, "Hẻm Bảy", "g2", 60, [4, 20, 60, 180, 320, 450], 50);
  place(27, "Hẻm Tám", "g2", 60, [4, 20, 60, 180, 320, 450], 50);

  // Exactly one parking square, so the middle-of-the-board pot has one home.
  spaces[20] = { kind: "parking", name: "Bãi đỗ xe", icon: "🅿️" };

  spaces[12] = { kind: "utility", name: "Điện", icon: "⚡", price: 150 } as never;
  spaces[28] = { kind: "utility", name: "Nước", icon: "💧", price: 150 } as never;
  // Square 5 is a station because 5 is reachable from Xuất phát on two legal
  // dice without rolling a double, which makes the station tests one line each.
  spaces[5] = { kind: "transport", name: "Ga Một", icon: "🚉", price: 200 } as never;
  spaces[15] = { kind: "transport", name: "Ga Hai", icon: "🚉", price: 200 } as never;
  spaces[25] = { kind: "transport", name: "Ga Ba", icon: "🚉", price: 200 } as never;
  spaces[35] = { kind: "transport", name: "Ga Bốn", icon: "🚉", price: 200 } as never;
  spaces[4] = { kind: "tax", name: "Thuế thu nhập", icon: "🧾", amount: 200, percent: 10 } as never;
  spaces[38] = { kind: "tax", name: "Thuế xa xỉ", icon: "💎", amount: 100 } as never;

  const groups = Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, name: `Nhóm ${i}` }));
  const result = normaliseMap({ name: "Bàn thử", spaces, groups });
  assertEquals(result.errors, []);
  assert(result.map, "the test board should load");
  return result.map;
}

interface Harness {
  game: MonopolyGame;
  /** Player ids in turn order. */
  order: string[];
  /** Queue two faces and take the turn. */
  roll: (a: number, b: number) => void;
  /** Every line the game has narrated, for asserting on what players were told. */
  log: string[];
  cash: (id: string) => number;
  pos: (id: string) => number;
  owner: (space: number) => string | null | undefined;
  level: (space: number) => number | undefined;
  rent: (space: number) => number | undefined;
  net: (id: string) => number;
  /** Move the game's clock on, for the tests about waiting. */
  tick: (ms: number) => void;
}

function harness(
  names: string[],
  rules: Partial<{ auction: boolean; parkingPot: boolean; doubleGo: boolean }> = {},
  // deno-lint-ignore no-explicit-any
  map: any = testMap(),
): Harness {
  const queue: number[] = [];
  // A plain LCG for the setup shuffles, so seating and deck order are fixed from
  // run to run without the test having to script them.
  let seed = 12345;
  const lcg = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const random = () => (queue.length ? queue.shift()! : lcg());

  const log: string[] = [];
  // Frozen unless a test moves it, so every deadline in the assertions below is
  // arithmetic rather than a race with the wall clock.
  let clock = 1_700_000_000_000;
  const game = new MonopolyGame(map, names, {
    auction: rules.auction ?? false,
    parkingPot: rules.parkingPot ?? false,
    doubleGo: rules.doubleGo ?? false,
  }, {
    nameOf: (id) => id,
    connected: () => true,
    say: (icon, text) => log.push(`${icon} ${text}`),
    onChange: () => {},
    random,
    now: () => clock,
  });

  const view = () => game.view();
  const order = [...view().players].sort((a, b) => a.order - b.order).map((p) => p.id);
  const player = (id: string) => view().players.find((p) => p.id === id)!;

  return {
    game,
    order,
    log,
    roll: (a, b) => {
      // Guarded, because the arithmetic below will happily manufacture a face of
      // 8 and a test that reaches a square no real roll can reach proves nothing.
      for (const face of [a, b]) {
        assert(
          Number.isInteger(face) && face >= 1 && face <= 6,
          `a die shows 1 to 6, not ${face}`,
        );
      }
      // (face - 0.5) / 6 floors to exactly `face - 1`, which is what the engine
      // adds 1 to. Half-way into the bucket, so no rounding sits on an edge.
      queue.push((a - 0.5) / 6, (b - 0.5) / 6);
      game.roll(view().turnId!);
    },
    cash: (id) => player(id).cash,
    pos: (id) => player(id).pos,
    owner: (space) => view().spaces[space].ownerId,
    level: (space) => view().spaces[space].level,
    rent: (space) => view().spaces[space].rent,
    net: (id) => player(id).net,
    tick: (ms) => {
      clock += ms;
    },
  };
}

/** Buy the square the current player is standing on. */
function buy(h: Harness): void {
  h.game.buy(h.game.view().pending.playerId);
}

/**
 * Hand over, if the board has not already done it.
 *
 * A turn with nothing left in it ends itself rather than waiting for a click
 * that carries no information, so `endTurn` is only legal when the player had
 * something they could still have done with the tail of it — which depends on
 * what they own and what it cost them, and is not what most of these tests are
 * about.
 */
function done(h: Harness, who: string): void {
  const pending = h.game.view().pending;
  if (pending.kind === "end" && pending.playerId === who) h.game.endTurn(who);
}

/**
 * Play out the current turn and hand over.
 *
 * A double earns another roll, so a turn is not one dice throw — scripting the
 * first roll and then asserting the turn is over is the mistake this exists to
 * stop. Extra rolls are spent on a harmless 7, offers to buy are declined, and
 * anything the test might actually care about (jail, a debt, the end of the
 * game) is left exactly where it is for the test to look at.
 */
function take(h: Harness, a: number, b: number): void {
  const who = h.game.view().turnId!;
  h.roll(a, b);
  for (let guard = 0; guard < 10; guard++) {
    const pending = h.game.view().pending;
    if (pending.playerId !== who) return;
    switch (pending.kind) {
      case "buy":
        h.game.decline(who);
        continue;
      case "tax":
        h.game.payTax(who, "flat");
        continue;
      case "upgrade":
        h.game.later(who);
        continue;
      case "roll":
        h.roll(3, 4);
        continue;
      case "end":
        h.game.endTurn(who);
        return;
      default:
        return;
    }
  }
}

/** Buy squares 2, 6 and 9 in one turn, off two doubles. Leaves the turn open. */
function grabGroupZero(h: Harness): string {
  const who = h.game.view().turnId!;
  h.roll(1, 1); // -> 2
  buy(h);
  h.roll(2, 2); // -> 6
  buy(h);
  h.roll(1, 2); // -> 9, and not a double, so the turn ends here
  buy(h);
  return who;
}

/**
 * Buy the dear pair, squares 16 and 19, in one turn. Leaves the turn open.
 *
 * Square 16 is out of reach of a single roll, so this goes by way of 12 — two
 * doubles and then a plain roll, which is the most a turn allows before the
 * third double sends you to jail.
 */
function grabGroupOne(h: Harness): string {
  const who = h.game.view().turnId!;
  h.roll(6, 6); // -> 12, the electricity board; not wanted
  h.game.decline(who);
  h.roll(2, 2); // -> 16
  buy(h);
  h.roll(1, 2); // -> 19, and not a double, so the turn ends here
  buy(h);
  return who;
}

/**
 * The two faces that add up to `sum` without being a double.
 *
 * A double earns another roll, which would make one throw more than one turn —
 * so a walk round the board is built out of these and nothing else.
 */
const NOT_A_DOUBLE: Record<number, [number, number]> = {
  3: [1, 2],
  4: [1, 3],
  5: [1, 4],
  6: [1, 5],
  7: [1, 6],
  8: [2, 6],
  9: [3, 6],
  10: [4, 6],
  11: [5, 6],
};

/**
 * Walk one player round the ring until they are standing on `target`.
 *
 * Rolling to a distant square takes several turns of real throws, and the
 * alternative — reaching inside the engine to move a piece — would test a board
 * position no game could ever reach. Squares passed through are declined or paid
 * at face value, and the go-to-jail square is stepped over rather than onto.
 */
function walkTo(h: Harness, who: string, target: number): void {
  for (let guard = 0; guard < 120; guard++) {
    if (h.game.view().turnId !== who) {
      take(h, 2, 5);
      continue;
    }
    const pos = h.game.view().players.find((p) => p.id === who)!.pos;
    const need = (target - pos + 40) % 40;
    // A sum under three needs a double, and overshooting means another lap —
    // either way, take a stride and come round again.
    let step = need >= 3 && need <= 11 ? need : 11;
    if ((pos + step) % 40 === 30) step = step > 3 ? step - 1 : step + 1;
    h.roll(...NOT_A_DOUBLE[step]);
    // Arrived: hand the square back with whatever it put on the table still
    // there, which is the thing the caller walked all this way to look at.
    if (h.game.view().players.find((p) => p.id === who)!.pos === target) return;
    const pending = h.game.view().pending;
    if (pending.playerId === who) {
      if (pending.kind === "buy") h.game.decline(who);
      else if (pending.kind === "tax") h.game.payTax(who, "flat");
      else if (pending.kind === "upgrade") h.game.later(who);
    }
    done(h, who);
  }
  throw new Error(`${who} never reached ${target}`);
}

/** Build `levels` on every square of a group, evenly, as the rules require. */
function buildUp(h: Harness, who: string, spaces: number[], levels: number): void {
  for (let level = 1; level <= levels; level++) {
    for (const space of spaces) h.game.build(who, space);
  }
}

// ---------------------------------------------------------------------------
// Setting up
// ---------------------------------------------------------------------------

Deno.test("everybody starts on Xuất phát with the same money and a piece of their own", () => {
  const h = harness(["a", "b", "c"]);
  const view = h.game.view();
  assertEquals(view.players.length, 3);
  for (const p of view.players) {
    assertEquals(p.cash, 1500);
    assertEquals(p.pos, 0);
    assertEquals(p.bankrupt, false);
  }
  // Pieces are distinct, or two players would be the same token on the board.
  assertEquals(new Set(view.players.map((p) => p.token)).size, 3);
  assertEquals(view.pending.kind, "roll");
  assertEquals(view.turnId, h.order[0]);
});

Deno.test("the shipped boards are all playable", () => {
  for (const id of ["vietnam", "hanoi", "hcmc", "danang"]) {
    const h = harness(["a", "b"], {}, builtinMap(id));
    const view = h.game.view();
    assertEquals(view.spaces.length, 40);
    // Square 5 is a transport square on the classic layout: it offers itself for
    // sale and moves nobody, which a Cơ hội square two along would not.
    assertEquals(view.spaces[5].kind, "transport");
    h.roll(2, 3);
    assertEquals(h.pos(h.order[0]), 5, `${id}: a 5 should land on square 5`);
    assertEquals(h.game.view().pending.kind, "buy");
  }
});

// ---------------------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------------------

Deno.test("you cannot act out of turn, or answer a question that was not asked", () => {
  const h = harness(["a", "b"]);
  const [first, second] = h.order;
  assertThrows(() => h.game.roll(second), MonopolyError, "Chưa tới lượt");
  // Buying before rolling is refused with the step, not a generic "no".
  assertThrows(() => h.game.buy(first), MonopolyError, "Tung xúc xắc");
  h.roll(1, 1); // -> square 2, unowned
  assertEquals(h.game.view().pending.kind, "buy");
  assertThrows(() => h.game.endTurn(first), MonopolyError, "Quyết định mua hay bỏ");
});

Deno.test("turns go round the table", () => {
  const h = harness(["a", "b", "c"]);
  const [x, y, z] = h.order;
  take(h, 2, 1);
  assertEquals(h.game.view().turnId, y);
  take(h, 2, 1);
  assertEquals(h.game.view().turnId, z);
  take(h, 2, 1);
  assertEquals(h.game.view().turnId, x);
});

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

Deno.test("a double earns another roll; the third double goes to jail", () => {
  const h = harness(["a", "b"]);
  const first = h.order[0];
  h.roll(1, 1); // -> 2, buy prompt
  h.game.decline(first);
  assertEquals(h.game.view().pending.kind, "roll", "a double keeps the dice");
  h.roll(2, 2); // -> 6
  h.game.decline(first);
  assertEquals(h.game.view().pending.kind, "roll");
  h.roll(3, 3); // third double
  assertEquals(h.pos(first), 10, "jail, not 12 squares further on");
  assert(h.game.view().players.find((p) => p.id === first)!.inJail);
  assertEquals(h.game.view().turnId, h.order[1], "and the turn is over");
});

Deno.test("passing Xuất phát pays a salary", () => {
  const h = harness(["a", "b"]);
  const first = h.order[0];
  // Six sevens is 42: one lap and two squares, so the salary lands exactly once.
  for (let lap = 0; lap < 6; lap++) {
    if (h.game.view().turnId !== first) take(h, 2, 1);
    assertEquals(h.game.view().turnId, first);
    take(h, 3, 4);
  }
  assertEquals(h.pos(first), 2, "42 squares from the start");
  assertEquals(
    h.log.filter((line) => line.includes("qua Xuất phát")).length,
    1,
    "paid once, for one lap",
  );
});

Deno.test("landing exactly on Xuất phát pays double when the house rule is on", () => {
  const h = harness(["a", "b"], { doubleGo: true });
  const first = h.order[0];
  // Five eights is 40 — round the board and onto Xuất phát itself.
  for (let step = 0; step < 5; step++) {
    if (h.game.view().turnId !== first) take(h, 2, 1);
    take(h, 3, 5);
  }
  assertEquals(h.pos(first), 0);
  assert(
    h.log.some((line) => line.includes("dừng đúng ô Xuất phát")),
    "and the extra payment is announced, not silent",
  );
});

// ---------------------------------------------------------------------------
// Buying, and rent
// ---------------------------------------------------------------------------

Deno.test("buying takes the asking price and puts your name on the deed", () => {
  const h = harness(["a", "b"]);
  const first = h.order[0];
  h.roll(1, 1); // -> 2, price 100
  assertEquals(h.game.view().pending.price, 100);
  buy(h);
  assertEquals(h.owner(2), first);
  assertEquals(h.cash(first), 1400);
});

Deno.test("rent is charged on landing, and doubles once one owner holds the whole group", () => {
  const h = harness(["a", "b"]);
  const [owner, visitor] = h.order;
  grabGroupZero(h);
  assertEquals(h.owner(9), owner);
  done(h, owner);

  // The visitor lands on square 2. Bare rent is 10, doubled for a full group.
  const before = h.cash(visitor);
  h.roll(1, 1);
  assertEquals(h.cash(visitor), before - 20, "full group doubles the bare rent");
  assertEquals(h.rent(2), 20, "and the board says so before you land");
  assertEquals(h.cash(owner), 1500 - 300 + 20, "which the owner received");
});

Deno.test("every player gets a colour of their own", () => {
  const h = harness(["a", "b", "c", "d", "e", "f", "g", "h"]);
  const hues = h.game.view().players.map((p) => p.hue);
  assertEquals(new Set(hues).size, hues.length, "no two seats share a hue");
  // Distinct is not enough — two hues four degrees apart are the same colour to
  // anybody looking at a piece the size of a square.
  const sorted = [...hues].sort((x, y) => x - y);
  const closest = Math.min(...sorted.slice(1).map((v, i) => v - sorted[i]));
  assert(closest >= 20, `the closest pair is only ${closest} degrees apart`);
});

Deno.test("landing on your own street is when the board asks you to build", () => {
  const h = harness(["a", "b"]);
  const owner = h.order[0];

  // 16 is one half of a two-member group. The other half is left on the market
  // on purpose: under the printed rule alone, nothing could ever be built here.
  walkTo(h, owner, 16);
  h.game.buy(owner);
  assert(
    h.game.view().pending.kind !== "upgrade",
    "buying it is not the same landing as coming back to it",
  );
  done(h, owner);
  assertEquals(h.owner(16), owner);
  assertEquals(h.owner(19), null);

  const away = h.game.view().spaces[16];
  assertEquals(away.canBuild, false, "not from across the board");
  assert(away.buildNote?.includes("ghé lại"), `said: ${away.buildNote}`);
  assertThrows(() => h.game.build(owner, 16), MonopolyError, "ghé lại");

  // Come back, and the board asks there and then.
  walkTo(h, owner, 16);
  const asked = h.game.view().pending;
  assertEquals(asked.kind, "upgrade");
  assertEquals(asked.space, 16);
  assertEquals(asked.buildCost, 100);
  assertEquals(asked.level, 1, "the storey it would take them to");
  assertEquals(h.game.view().spaces[16].canBuild, true, "and only now is it allowed");

  h.game.build(owner, 16);
  assertEquals(h.level(16), 1);
  assertEquals(h.rent(16), 100, "and rent jumps to the one-house tier");

  // The offer stays open while there is another storey to be had: somebody
  // standing on their own street with the money for two houses gets two.
  assertEquals(h.game.view().pending.kind, "upgrade");
  h.game.build(owner, 16);
  assertEquals(h.level(16), 2);
  assertEquals(h.rent(16), 300);

  h.game.later(owner);
  assertEquals(h.game.view().spaces[16].canBuild, false, "and the door shuts behind them");
  assertThrows(() => h.game.build(owner, 16), MonopolyError, "ghé lại");
});

Deno.test("a turn with nothing left in it ends itself", () => {
  const h = harness(["a", "b"]);
  const first = h.order[0];
  // Ô trống 7: nobody's, nothing to pay, nothing to build. There is no decision
  // left to make, so the board does not stop to ask for one.
  h.roll(3, 4);
  assertEquals(h.pos(first), 7);
  assertEquals(h.game.view().turnId, h.order[1], "play moved on by itself");

  // With something worth doing, it waits: coming home to 16 with the money for a
  // house is a question, and the board stops to ask it.
  const owner = h.game.view().turnId!;
  walkTo(h, owner, 16);
  h.game.buy(owner);
  done(h, owner);
  walkTo(h, owner, 16);
  assertEquals(h.game.view().pending.kind, "upgrade");
  assertEquals(h.game.view().pending.playerId, owner, "waiting on the builder");
});

// ---------------------------------------------------------------------------
// Khí vận, the lucky draw
//
// The deck is data, so what is worth testing is the machinery: that the draw is
// weighted rather than dealt, that the rarity reaches the browser, and that the
// four cards which move property between players do it legally.
// ---------------------------------------------------------------------------

/**
 * The test board with a Khí vận square put where the test wants one, and a
 * one-card deck so the draw is the effect under test.
 *
 * The board is patched after normalising rather than before: these are made-up
 * squares for a made-up board, and running them past the map validator would be
 * testing the validator.
 */
function chestAt(
  index: number,
  effect: Record<string, unknown>,
  tier = "epic",
  // deno-lint-ignore no-explicit-any
): any {
  const map = testMap();
  return {
    ...map,
    // deno-lint-ignore no-explicit-any
    spaces: map.spaces.map((space: any, i: number) =>
      i === index ? { kind: "chest", name: "Khí vận", icon: "🧧", note: "", scene: "" } : space
    ),
    chest: [{ tier, icon: "🧧", text: "Thẻ thử.", effect }],
  };
}

function shieldsOf(h: Harness, id: string): number {
  return h.game.view().players.find((p) => p.id === id)!.shields;
}

Deno.test("the draw is weighted, so the good cards stay rare", () => {
  let seed = 20260827;
  const lcg = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const tally = new Map<string, number>();
  for (let n = 0; n < 6000; n++) {
    const card = drawChestCard(CHEST_CARDS, lcg);
    tally.set(card.tier, (tally.get(card.tier) ?? 0) + 1);
  }
  const common = tally.get("common") ?? 0;
  const legend = tally.get("legend") ?? 0;
  assert(legend > 0, "a legendary does turn up");
  assert(common > legend * 4, `common ${common} should dwarf legend ${legend}`);
  // Every tier is reachable, or a card nobody can draw is a card nobody wrote.
  for (const tier of CHEST_TIERS) {
    assert((tally.get(tier.id) ?? 0) > 0, `nothing ever came out at ${tier.id}`);
  }
});

Deno.test("a deck with no rarities in it still draws", () => {
  const plain = [{ icon: "🧧", text: "Không hạng.", effect: { k: "cash", amount: 10 } }];
  const card = drawChestCard(plain, () => 0.99);
  assertEquals(card.text, "Không hạng.");
});

Deno.test("every Khí vận card names a tier", () => {
  const ids = new Set(CHEST_TIERS.map((t) => t.id));
  for (const card of CHEST_CARDS) {
    assert(ids.has(card.tier), `${card.text} has tier ${card.tier}`);
  }
});

Deno.test("a Khí vận card arrives with its rarity and a serial number", () => {
  const h = harness(["a", "b"], {}, chestAt(3, { k: "cash", amount: 25 }, "legend"));
  h.roll(1, 2); // -> 3
  const card = h.game.view().card!;
  assertEquals(card.deck, "chest");
  assertEquals(card.tier, "legend");
  assertEquals(card.no, 1, "counted, because two identical draws look identical");
  assert(h.log.some((line) => line.includes("Truyền thuyết")), "and the rarity is said aloud");
});

Deno.test("a shield off the draw waives the next rent, once", () => {
  const h = harness(["a", "b"], {}, chestAt(3, { k: "shield" }, "legend"));
  const [first, second] = h.order;

  h.roll(2, 4); // first: 0 -> 6, and buys the street
  assertEquals(h.pos(first), 6);
  buy(h);
  done(h, first);

  h.roll(1, 2); // second: 0 -> 3, the Khí vận square
  assertEquals(shieldsOf(h, second), 1, "one rent, waived");
  done(h, second);

  take(h, 3, 4); // first, out of the way

  const before = h.cash(second);
  h.roll(1, 2); // second: 3 -> 6, which is not theirs
  assertEquals(h.pos(second), 6);
  assertEquals(h.cash(second), before, "nothing was charged");
  assertEquals(shieldsOf(h, second), 0, "and the shield was spent");
  assert(h.log.some((line) => line.includes("bảo kê")), "and the table was told why");
});

Deno.test("a card can hand your cheapest deed to whoever is worth least", () => {
  const h = harness(["a", "b"], {}, chestAt(13, { k: "giveDeed" }));
  const [first, second] = h.order;

  h.roll(1, 1); // -> 2, Ngõ Một at 100
  buy(h);
  h.roll(1, 2); // the double earned another throw: -> 5, Ga Một at 200
  buy(h);
  done(h, first);
  take(h, 3, 4);

  h.roll(3, 5); // first: 5 -> 13, the Khí vận square
  assertEquals(h.owner(2), second, "the cheap deed went to the poorer player");
  assertEquals(h.owner(5), first, "and the dear one stayed put");
});

Deno.test("a card can swap your cheapest deed with the richest player's", () => {
  const h = harness(["a", "b"], {}, chestAt(13, { k: "swapDeed" }));
  const [first, second] = h.order;

  h.roll(1, 1); // first -> 2, Ngõ Một at 100
  buy(h);
  h.roll(3, 4); // -> 9, left on the market
  h.game.decline(first);
  done(h, first);

  h.roll(6, 6); // second -> 12, Điện at 150
  buy(h);
  h.roll(2, 2); // -> 16, Phố Bốn at 200
  buy(h);
  h.roll(3, 4); // -> 23, nothing, and not a double
  done(h, second);

  h.roll(1, 3); // first: 9 -> 13
  assertEquals(h.owner(2), second, "their cheapest went across");
  assertEquals(h.owner(12), first, "and the other player's cheapest came back");
  assertEquals(h.owner(16), second, "the dear one was not touched");
});

Deno.test("a card can knock a building down, evenly", () => {
  const h = harness(["a", "b"], {}, chestAt(13, { k: "sellBuilding" }));
  const owner = grabGroupZero(h);
  done(h, owner);
  buildUp(h, owner, [2, 6, 9], 1);
  h.game.build(owner, 2);
  assertEquals(h.level(2), 2, "one street is a storey ahead");

  take(h, 3, 4);
  const before = h.cash(owner);
  h.roll(1, 3); // owner: 9 -> 13
  assertEquals(h.level(2), 1, "the tallest came down, which is the even one to take");
  assertEquals(h.cash(owner), before + 25, "and half the build price came back");
});

Deno.test("a card can build one for free, and still not break even build", () => {
  const h = harness(["a", "b"], {}, chestAt(13, { k: "freeBuild" }, "legend"));
  const owner = grabGroupZero(h);
  done(h, owner);
  take(h, 3, 4);

  const before = h.cash(owner);
  h.roll(1, 3); // owner: 9 -> 13
  const levels = [2, 6, 9].map((i) => h.level(i));
  assertEquals(levels.filter((l) => l === 1).length, 1, "exactly one storey went up");
  assertEquals(h.cash(owner), before, "and it cost nothing");
});

Deno.test("a card with nothing to move says so rather than sticking", () => {
  const h = harness(["a", "b"], {}, chestAt(3, { k: "swapDeed" }));
  h.roll(1, 2);
  assert(h.log.some((line) => line.includes("bỏ trống")), "the card is spent, not stuck");
  assert(h.game.view().turnId !== null, "and the game carried on");
});

Deno.test("a partial group charges bare rent", () => {
  const h = harness(["a", "b"]);
  const [owner, visitor] = h.order;
  h.roll(6, 6); // -> 12, a utility
  h.game.decline(owner);
  h.roll(2, 2); // -> 16, one half of the dear pair
  buy(h);
  h.roll(1, 2); // -> 19, the other half, deliberately left on the market
  h.game.decline(owner);
  assertEquals(h.owner(16), owner);
  assertEquals(h.owner(19), null);
  done(h, owner);

  const before = h.cash(visitor);
  h.roll(6, 6);
  h.game.decline(visitor);
  h.roll(2, 2); // visitor -> 16
  assertEquals(h.cash(visitor), before - 20, "one of two is not a monopoly");
});

Deno.test("a station charges by how many stations its owner holds", () => {
  const h = harness(["a", "b"]);
  const [owner, visitor] = h.order;
  h.roll(2, 3); // -> 5, a station, and not a double
  buy(h);
  done(h, owner);
  assertEquals(h.rent(5), 25, "one station");

  const before = h.cash(visitor);
  h.roll(2, 3);
  assertEquals(h.cash(visitor), before - 25);

  // A second station in the same hands doubles it, without any group rule.
  done(h, visitor);
  h.roll(4, 6); // owner: 5 -> 15, the second station
  buy(h);
  assertEquals(h.rent(5), 50, "two stations");
  assertEquals(h.rent(15), 50);
});

Deno.test("a utility charges a multiple of the dice, not a fixed rent", () => {
  const h = harness(["a", "b"]);
  const [_owner, visitor] = h.order;
  h.roll(6, 6); // -> 12, a utility, and a double
  buy(h);
  take(h, 3, 4); // spend the extra roll and hand over

  const before = h.cash(visitor);
  h.roll(6, 6); // 12 on the dice, one utility owned -> four times
  assertEquals(h.cash(visitor), before - 48);
});

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

Deno.test("houses need the whole group, go up evenly, and raise the rent", () => {
  const h = harness(["a", "b"]);
  const owner = h.order[0];

  h.roll(1, 1);
  buy(h); // square 2 only
  assertThrows(
    () => h.game.build(owner, 2),
    MonopolyError,
    "cả nhóm màu",
    "one deed is not a group",
  );
  h.roll(2, 2);
  buy(h);
  h.roll(1, 2);
  buy(h);

  h.game.build(owner, 2);
  assertEquals(h.level(2), 1);
  assertEquals(h.rent(2), 50, "one house, and the group doubling no longer applies");
  assertThrows(
    () => h.game.build(owner, 2),
    MonopolyError,
    "xây đều",
    "a second house here while two squares still have none",
  );
  h.game.build(owner, 6);
  h.game.build(owner, 9);
  h.game.build(owner, 2);
  assertEquals(h.level(2), 2);
  assertEquals(h.rent(2), 150);
});

Deno.test("a hotel is the fifth building and rents accordingly", () => {
  const h = harness(["a", "b"]);
  const owner = grabGroupZero(h);
  buildUp(h, owner, [2, 6, 9], 5);
  assertEquals(h.level(2), 5);
  assertEquals(h.rent(2), 750, "hotel rent");
  assertThrows(() => h.game.build(owner, 2), MonopolyError, "khách sạn");
});

Deno.test("selling a building returns half, and must come off the tallest first", () => {
  const h = harness(["a", "b"]);
  const owner = grabGroupZero(h);
  buildUp(h, owner, [2, 6, 9], 1);
  h.game.build(owner, 2); // 2 is now taller than 6 and 9
  assertThrows(() => h.game.sellBuilding(owner, 9), MonopolyError, "bán đều");
  const before = h.cash(owner);
  h.game.sellBuilding(owner, 2);
  assertEquals(h.cash(owner), before + 25, "half of a 50 house");
  assertEquals(h.level(2), 1);
});

// ---------------------------------------------------------------------------
// Mortgages
// ---------------------------------------------------------------------------

Deno.test("a mortgaged square raises half its price, collects no rent, and costs 110% back", () => {
  const h = harness(["a", "b"]);
  const [owner, visitor] = h.order;
  h.roll(1, 1); // square 2, price 100 — and a double
  buy(h);
  take(h, 3, 4); // spend the extra roll and hand over

  const before = h.cash(owner);
  h.game.mortgage(owner, 2);
  assertEquals(h.cash(owner), before + 50);
  assertEquals(h.rent(2), undefined, "a mortgaged square quotes no rent");

  const visitorBefore = h.cash(visitor);
  h.roll(1, 1); // visitor lands on the mortgaged square
  assertEquals(h.cash(visitor), visitorBefore, "and charges none");

  const owed = h.cash(owner);
  h.game.unmortgage(owner, 2);
  assertEquals(h.cash(owner), owed - 55, "50 back plus 10% interest");
  assertEquals(h.rent(2), 10);
});

Deno.test("you cannot mortgage out from under your own houses", () => {
  const h = harness(["a", "b"]);
  const owner = grabGroupZero(h);
  h.game.build(owner, 2);
  assertThrows(() => h.game.mortgage(owner, 6), MonopolyError, "bán hết nhà");
});

// ---------------------------------------------------------------------------
// Tax and jail
// ---------------------------------------------------------------------------

Deno.test("income tax offers both amounts and charges the one chosen", () => {
  const h = harness(["a", "b"]);
  const first = h.order[0];
  h.roll(2, 2); // -> square 4, income tax
  const pending = h.game.view().pending;
  assertEquals(pending.kind, "tax");
  assertEquals(pending.flat, 200);
  assertEquals(pending.percentAmount, 150, "10% of the 1500 held");
  h.game.payTax(first, "percent");
  assertEquals(h.cash(first), 1350);
});

/** Three doubles is the one route into jail that needs no particular square. */
function jailByDoubles(h: Harness): string {
  const who = h.game.view().turnId!;
  h.roll(1, 1);
  h.game.decline(who);
  h.roll(2, 2);
  h.game.decline(who);
  h.roll(3, 3);
  assert(h.game.view().players.find((s) => s.id === who)!.inJail, "three doubles is jail");
  return who;
}

Deno.test("jail: the fine buys you out, and you still get your roll", () => {
  const h = harness(["a", "b"]);
  const jailed = jailByDoubles(h);
  assertEquals(h.pos(jailed), 10);

  take(h, 2, 1); // the other player
  assertEquals(h.game.view().turnId, jailed);
  assertEquals(h.game.view().pending.kind, "jail");
  assertEquals(h.game.view().pending.bail, 50);

  const before = h.cash(jailed);
  h.game.leaveJail(jailed, "pay");
  assertEquals(h.cash(jailed), before - 50);
  assertEquals(h.game.view().pending.kind, "roll", "out, and the dice are yours");
  assertEquals(h.game.view().players.find((s) => s.id === jailed)!.inJail, false);
});

Deno.test("rolling a double in jail gets you out and moves you, but earns no extra roll", () => {
  const h = harness(["a", "b"]);
  const jailed = jailByDoubles(h);
  take(h, 2, 1);
  assertEquals(h.game.view().turnId, jailed);
  h.roll(4, 4); // a double: out, and move 8
  const seat = h.game.view().players.find((s) => s.id === jailed)!;
  assertEquals(seat.inJail, false);
  assertEquals(seat.pos, 18);
  // 18 is nobody's and nothing to decide, so the turn ends itself — which is the
  // proof there was no second roll waiting for them.
  const other = h.order.find((id) => id !== jailed)!;
  assertEquals(h.game.view().turnId, other, "no second roll for getting out");
});

Deno.test("three failed attempts in jail forces the fine and moves you on", () => {
  const h = harness(["a", "b"]);
  const jailed = jailByDoubles(h);
  const other = h.order.find((id) => id !== jailed)!;

  for (let attempt = 1; attempt <= 3; attempt++) {
    take(h, 2, 1); // the other player
    assertEquals(h.game.view().turnId, jailed);
    h.roll(3, 2); // not a double
    if (h.game.view().pending.kind === "buy") h.game.decline(jailed);
    if (h.game.view().pending.kind === "end") h.game.endTurn(jailed);
  }
  const seat = h.game.view().players.find((s) => s.id === jailed)!;
  assertEquals(seat.inJail, false, "let out after the third attempt");
  assertEquals(seat.cash, 1500 - 50, "having paid the fine");
  assertEquals(seat.pos, 15, "and moved the 5 that was rolled");
  assert(other, "the other player is still in the game");
});

// ---------------------------------------------------------------------------
// Auctions
// ---------------------------------------------------------------------------

Deno.test("refusing a square puts it up for auction, and the last bidder standing takes it", () => {
  const h = harness(["a", "b", "c"], { auction: true });
  const [first, second, third] = h.order;
  h.roll(1, 1); // -> square 2
  h.game.decline(first);
  const auction = h.game.view().auction!;
  assertEquals(auction.space, 2);
  assertEquals(
    auction.activeIds.length,
    3,
    "everyone bids, including whoever just refused it",
  );

  h.game.bid(second, 40);
  assertThrows(() => h.game.bid(third, 30), MonopolyError, "cao hơn");
  h.game.bid(third, 60);
  h.game.withdrawBid(first);
  h.game.withdrawBid(second);
  assertEquals(h.game.view().auction, null, "settled");
  assertEquals(h.owner(2), third);
  assertEquals(h.cash(third), 1500 - 60, "paid the bid, not the asking price");
});

// The pending state stays on "buy" for the whole auction so the turn can resume
// afterwards, which is exactly the trap: every turn action has to be refused while
// the hammer is up, or refusing a square becomes a way to think about it.
Deno.test("an open auction suspends the turn, but not the raising of cash", () => {
  const h = harness(["a", "b"], { auction: true });
  const [first, second] = h.order;
  h.roll(1, 1); // -> square 2, on the market
  h.game.decline(first);

  assertThrows(
    () => h.game.buy(first),
    MonopolyError,
    "Đang đấu giá",
    "the player who refused it cannot buy it at the asking price mid-auction",
  );
  assertThrows(
    () => h.game.decline(first),
    MonopolyError,
    "Đang đấu giá",
    "and cannot refuse it twice to wipe out the bids",
  );
  assertThrows(() => h.game.roll(first), MonopolyError, "Đang đấu giá");
  assertThrows(() => h.game.endTurn(first), MonopolyError, "Đang đấu giá");

  // Mortgaging is how a bidder finds the money, so it stays open.
  h.game.bid(second, 40);
  h.game.withdrawBid(first);
  assertEquals(h.owner(2), second, "the auction still settles normally");
  // Square 2 is only reachable off a double, so resuming means another roll.
  assertEquals(h.game.view().pending.kind, "roll", "and the turn resumes where it was");
  assertEquals(h.game.view().turnId, first, "still the same player's turn");
});

// The bug: `waitingOn` is null while the hammer is up, because an auction waits
// on every bidder rather than on one player, and the machine only ever answered
// for whoever `waitingOn` named. One player who had gone to answer the door was
// enough to stop the table dead at the first refused square — nothing could make
// them bid, nothing could make them fold, and no clock was even running.
Deno.test("the machine answers an auction too, so one absent bidder cannot stall it", () => {
  const h = harness(["a", "b", "c"], { auction: true });
  const [first, second, third] = h.order;
  h.roll(1, 1); // -> square 2
  h.game.decline(first);

  assertEquals(h.game.waitingOn(), null, "an auction waits on nobody in particular");
  assertEquals(
    [...h.game.waitingIds()].sort(),
    [first, second, third].sort(),
    "it waits on every bidder still in it",
  );
  assert(h.game.autoDeadline() !== null, "and there is a fuse on it");

  // It folds rather than bidding: that never spends money nobody is watching,
  // and it is the only answer that always ends an auction.
  assert(h.game.autoMove(first), "the machine answered for the absent player");
  assertEquals(h.game.view().auction!.activeIds.includes(first), false, "it withdrew them");

  h.game.bid(second, 40);
  assert(h.game.autoMove(third), "and again for the next one");
  assertEquals(h.game.view().auction, null, "the hammer fell");
  assertEquals(h.owner(2), second);
});

Deno.test("a new bid restarts the clock on everybody else", () => {
  const h = harness(["a", "b", "c"], { auction: true });
  const [first, second] = h.order;
  h.roll(1, 1);
  h.game.decline(first);
  const opened = h.game.autoDeadline()!;

  h.tick(5_000);
  h.game.bid(second, 40);
  assertEquals(
    h.game.autoDeadline()! - opened,
    5_000,
    "a new highest bid is a new question, so the fuse starts again",
  );

  h.tick(3_000);
  h.game.withdrawBid(first);
  assertEquals(h.game.autoDeadline()! - opened, 8_000, "and so does somebody dropping out");
});

Deno.test("nobody may bid money they do not have", () => {
  const h = harness(["a", "b"], { auction: true });
  const [first, second] = h.order;
  h.roll(1, 1);
  h.game.decline(first);
  assertThrows(() => h.game.bid(second, 2000), MonopolyError, "chỉ có");
});

Deno.test("with auctions off, refusing a square simply leaves it on the market", () => {
  const h = harness(["a", "b"], { auction: false });
  const first = h.order[0];
  h.roll(1, 1);
  h.game.decline(first);
  assertEquals(h.game.view().auction, null);
  assertEquals(h.owner(2), null);
});

// ---------------------------------------------------------------------------
// Debt and bankruptcy
// ---------------------------------------------------------------------------

Deno.test("rent you cannot cover is a debt you can sell your way out of", () => {
  const h = harness(["a", "b"]);
  const [debtor, owner] = h.order;

  // The debtor takes the cheap group and builds three houses on each: 300 for
  // the deeds and 450 for the houses leaves 750 in cash.
  grabGroupZero(h);
  buildUp(h, debtor, [2, 6, 9], 3);
  assertEquals(h.cash(debtor), 750);
  done(h, debtor);

  // The owner takes the dear pair and builds three each — rent 900 a visit.
  grabGroupOne(h);
  buildUp(h, owner, [16, 19], 3);
  assertEquals(h.rent(16), 900);
  done(h, owner);

  // Seven squares from 9 is 16, and 900 is more than 750.
  h.roll(3, 4);
  const pending = h.game.view().pending;
  assertEquals(pending.kind, "debt");
  assertEquals(pending.playerId, debtor);
  assertEquals(pending.amount, 900);
  assertEquals(pending.toId, owner);
  assertThrows(
    () => h.game.declareBankrupt(debtor),
    MonopolyError,
    "vẫn còn đủ tài sản",
    "giving up is not allowed while the houses could still be sold",
  );

  // Sell the tallest square each time, as the even-sell rule requires.
  const ownerBefore = h.cash(owner);
  let guard = 0;
  while (h.game.view().pending.kind === "debt" && guard++ < 20) {
    const tallest = [2, 6, 9].sort((a, b) => h.level(b)! - h.level(a)!)[0];
    h.game.sellBuilding(debtor, tallest);
  }
  // Paid to the last note, so there is nothing left to do with the turn and the
  // board hands over rather than waiting to be told to.
  assertEquals(h.game.view().pending.kind, "roll", "the debt is settled");
  assertEquals(h.game.view().turnId, owner, "and play moves on");
  assertEquals(h.cash(debtor), 0, "to the last note");
  assertEquals(h.cash(owner), ownerBefore + 900, "which the owner received");
  assertEquals(h.game.view().players.find((p) => p.id === debtor)!.bankrupt, false);
});

Deno.test("bankruptcy hands everything to the creditor and ends the game", () => {
  const h = harness(["a", "b"]);
  const [owner, debtor] = h.order;

  grabGroupOne(h);
  buildUp(h, owner, [16, 19], 5); // hotels: 1500 a visit
  assertEquals(h.rent(16), 1500);
  done(h, owner);

  // The debtor walks 12 then 4 — two doubles, so all of it is one turn.
  h.roll(6, 6); // -> 12, the utility
  h.game.decline(debtor);
  h.roll(2, 2); // -> 16: 1500 owed against exactly 1500, which empties them
  assertEquals(h.pos(debtor), 16);
  assertEquals(h.cash(debtor), 0);

  // The second double leaves the dice with them, and the next hotel is 3 along.
  h.roll(1, 2); // -> 19, with nothing left and nothing to sell
  const pending = h.game.view().pending;
  assertEquals(pending.kind, "debt");
  assertEquals(pending.playerId, debtor);
  assertEquals(pending.amount, 1500);

  h.game.declareBankrupt(debtor);
  const view = h.game.view();
  assertEquals(view.players.find((p) => p.id === debtor)!.bankrupt, true);
  assertEquals(view.winnerId, owner);
  assertEquals(view.pending.kind, "over");
  assert(h.log.some((l) => l.includes("thắng")), "and the room is told who won");
  assertThrows(() => h.game.roll(owner), MonopolyError, "kết thúc");
});

Deno.test("a bankrupt player hands their deeds to the creditor, not to the bank", () => {
  const h = harness(["a", "b", "c"]);
  const [owner, debtor] = h.order;

  grabGroupOne(h);
  buildUp(h, owner, [16, 19], 5);
  done(h, owner);

  h.roll(2, 3); // debtor buys the station at 5 for 200
  buy(h);
  assertEquals(h.cash(debtor), 1300);
  done(h, debtor);
  take(h, 2, 1); // the third player, out of the way
  take(h, 3, 4); // and the owner, back round to the debtor

  assertEquals(h.game.view().turnId, debtor);
  h.roll(5, 6); // debtor: 5 -> 16, owes 1500 against 1300
  assertEquals(h.game.view().pending.kind, "debt");
  // Mortgaging the station raises 100 — still short of 1500.
  h.game.mortgage(debtor, 5);
  assertEquals(h.game.view().pending.kind, "debt", "still short");
  h.game.declareBankrupt(debtor);
  assertEquals(h.owner(5), owner, "the deed changed hands rather than being freed");
  assertEquals(h.game.view().winnerId, null, "and with three players it is not over");
});

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

Deno.test("a trade moves deeds and cash both ways once accepted", () => {
  const h = harness(["a", "b"]);
  const [first, second] = h.order;
  h.roll(1, 1);
  buy(h); // first owns square 2
  take(h, 3, 4);
  h.roll(2, 3);
  buy(h); // second owns the station at 5
  done(h, second);

  h.game.propose(first, second, {
    giveSpaces: [2],
    giveCash: 50,
    wantSpaces: [5],
    wantCash: 0,
  });
  const trade = h.game.view().trades[0];
  assertEquals(trade.fromId, first);
  assertThrows(
    () => h.game.respond(first, trade.id, true),
    MonopolyError,
    "không dành cho bạn",
    "you cannot accept your own offer",
  );

  const firstBefore = h.cash(first);
  const secondBefore = h.cash(second);
  h.game.respond(second, trade.id, true);
  assertEquals(h.owner(2), second);
  assertEquals(h.owner(5), first);
  assertEquals(h.cash(first), firstBefore - 50);
  assertEquals(h.cash(second), secondBefore + 50);
  assertEquals(h.game.view().trades.length, 0, "and the offer is off the table");
});

Deno.test("a declined offer leaves everything where it was", () => {
  const h = harness(["a", "b"]);
  const [first, second] = h.order;
  h.roll(1, 1);
  buy(h);
  take(h, 3, 4);

  h.game.propose(first, second, {
    giveSpaces: [],
    giveCash: 0,
    wantSpaces: [],
    wantCash: 300,
  });
  const trade = h.game.view().trades[0];
  h.game.respond(second, trade.id, false);
  assertEquals(h.cash(second), 1500);
  assertEquals(h.game.view().trades.length, 0);
});

Deno.test("houses cannot be traded away under a deed", () => {
  const h = harness(["a", "b"]);
  const [first, second] = h.order;
  grabGroupZero(h);
  h.game.build(first, 2);
  assertThrows(
    () =>
      h.game.propose(first, second, {
        giveSpaces: [2],
        giveCash: 0,
        wantSpaces: [],
        wantCash: 0,
      }),
    MonopolyError,
    "bán hết trước khi đổi",
  );
});

Deno.test("you cannot offer what is not yours", () => {
  const h = harness(["a", "b"]);
  const [first, second] = h.order;
  assertThrows(
    () =>
      h.game.propose(first, second, {
        giveSpaces: [2],
        giveCash: 0,
        wantSpaces: [],
        wantCash: 0,
      }),
    MonopolyError,
    "không thuộc người đó",
  );
});

// ---------------------------------------------------------------------------
// House rules
// ---------------------------------------------------------------------------

Deno.test("with the middle-of-the-board rule on, fines pile up and are collected", () => {
  const h = harness(["a", "b"], { parkingPot: true });
  const first = h.order[0];
  h.roll(2, 2); // -> square 4, income tax, and a double
  h.game.payTax(first, "flat"); // 200 into the middle
  assertEquals(h.game.view().pot, 200);
  assertEquals(h.cash(first), 1300);

  h.roll(5, 6); // the extra roll: 4 -> 15, a station
  h.game.decline(first);
  done(h, first);
  take(h, 2, 1); // the other player

  h.roll(2, 3); // 15 -> 20, the free parking square
  assertEquals(h.pos(first), 20);
  assertEquals(h.cash(first), 1500, "the 200 came back out of the middle");
  assertEquals(h.game.view().pot, 0);
});

Deno.test("without the house rule there is no pot at all", () => {
  const h = harness(["a", "b"], { parkingPot: false });
  const first = h.order[0];
  h.roll(2, 2);
  h.game.payTax(first, "flat");
  assertEquals(h.game.view().pot, null, "not zero — the rule is simply not in play");
});

Deno.test("calling time awards the game on net worth", () => {
  const h = harness(["a", "b"]);
  const [first] = h.order;
  h.roll(1, 1);
  buy(h);
  assertEquals(h.net(first), 1500, "cash down 100, a 100 deed in hand");
  h.game.callTime();
  const view = h.game.view();
  assertEquals(view.pending.kind, "over");
  assert(view.winnerId, "somebody won");
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

Deno.test("a player who leaves puts their deeds back on the market", () => {
  const h = harness(["a", "b", "c"]);
  const [first] = h.order;
  h.roll(1, 1);
  buy(h);
  assertEquals(h.owner(2), first);
  h.game.removePlayer(first);
  assertEquals(h.owner(2), null);
  assertEquals(h.game.view().players.find((p) => p.id === first)!.bankrupt, true);
  assert(h.game.view().turnId !== first, "and the turn moves on");
});

Deno.test("the host may only skip somebody whose browser has gone", () => {
  const connected = new Set(["a", "b"]);
  const queue: number[] = [];
  let seed = 999;
  const game = new MonopolyGame(
    testMap(),
    ["a", "b"],
    { auction: false, parkingPot: false, doubleGo: false },
    {
      nameOf: (id) => id,
      connected: (id) => connected.has(id),
      say: () => {},
      onChange: () => {},
      random: () => {
        if (queue.length) return queue.shift()!;
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      },
      now: () => 1_700_000_000_000,
    },
  );
  const inTurn = game.view().turnId!;
  assertThrows(() => game.skip("a", "a"), MonopolyError, "vẫn đang kết nối");
  connected.delete(inTurn);
  game.skip("a", "a");
  assert(game.view().turnId !== inTurn, "the turn moved on");
});

// ---------------------------------------------------------------------------
// The room around it
// ---------------------------------------------------------------------------

Deno.test("monopoly needs two players and takes at most eight", async () => {
  const solo = await makeRoom({ mode: "monopoly" }, ["ann"]);
  assertThrows(() => solo.room.start(idFor("ann")), RoomError, "ít nhất 2");

  const names = ["ann", "bo", "cy", "di", "ed", "fi", "gus", "hal"];
  const full = await makeRoom({ mode: "monopoly" }, names);
  assertEquals(full.room.players.size, MAX_MONOPOLY_PLAYERS);
  assertThrows(() => full.room.join("zzzzzzzz9", "ivy"), RoomError, "đã đủ");
});

Deno.test("a monopoly room starts a board game rather than a round of words", async () => {
  const t = await makeRoom({ mode: "monopoly" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  assertEquals(t.room.phase, "playing");
  assert(t.room.mono, "the game exists");
  assertEquals(t.room.secret, null, "and no secret word was drawn");
  const view = t.room.viewFor(idFor("ann"));
  assertEquals(view.mono?.players.length, 2);
  assertEquals(view.board, null, "no guess board");
  // A stale tab guessing into a board room is refused by name.
  const outcome = t.room.guess(idFor("ann"), "hello");
  assertEquals(outcome.accepted, false);
  assert(!outcome.accepted && outcome.message.includes("cờ tỷ phú"));
});

Deno.test("somebody arriving mid-game gets a chair, not a seat", async () => {
  const t = await makeRoom({ mode: "monopoly" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  const late = t.room.join("zzzzzzzz1", "cy");
  assertEquals(t.room.mono?.hasSeat(late.id), false, "no seat at a board already dealt");
  assert(t.room.isSpectator(late.id), "watching");
  assertEquals(t.room.viewFor(late.id).you.spectator, true, "and told so");
  assertThrows(() => t.room.monoAction(late.id, { a: "roll" }), RoomError, "đang xem");

  // Which is the whole point of the vote: agreeing to start over deals them in.
  t.room.monoRestartAsk(late.id);
  t.room.monoRestartVote(idFor("ann"), true);
  t.room.monoRestartVote(idFor("bo"), true);
  assertEquals(t.room.mono?.hasSeat(late.id), true, "dealt into the new game");
  assertEquals(t.room.mono?.seatIds().length, 3);
});

Deno.test("a player can hand their turns to the machine, and take them back", async () => {
  const t = await makeRoom({ mode: "monopoly" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  const game = t.room.mono!;
  const waiting = game.waitingOn()!;

  t.room.monoAuto(waiting, true);
  assertEquals(t.room.viewFor(waiting).you.auto, true, "the box is ticked");
  assert(
    t.room.viewFor(idFor("ann")).mono!.autoIds.includes(waiting),
    "and the whole table can see it",
  );

  // The machine answers the question actually on the table, which at kick-off is
  // the dice.
  assertEquals(game.view().pending.kind, "roll");
  assert(game.autoMove(waiting), "it played");
  assertEquals(game.view().rollNo, 1, "the dice were thrown");

  // A move of their own is the only reliable sign somebody came back.
  const nowWaiting = game.waitingOn()!;
  t.room.monoAuto(nowWaiting, true);
  const action = game.view().pending.kind === "roll" ? "roll" : "hold";
  t.room.monoAction(nowWaiting, { a: action } as never);
  assertEquals(t.room.viewFor(nowWaiting).you.auto, false, "switched off by playing");
});

Deno.test("the board says when it will answer for you, and holding puts it back", async () => {
  const t = await makeRoom({ mode: "monopoly" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  const view = t.room.viewFor(idFor("ann")).mono!;
  assertEquals(view.waitingOn, view.pending.playerId);
  assertEquals(view.autoAt, view.waitAt + AUTO_IDLE_MS, "the full wait for a real decision");
});

Deno.test("a room's auction runs on a clock, and the machine can end it", async () => {
  const t = await makeRoom({ mode: "monopoly", monoAuction: true }, ["ann", "bo", "cy"]);
  t.room.start(idFor("ann"));
  const game = t.room.mono!;

  // A room plays a real board with real dice, so there is no scripting the route
  // here: walk it forward with the machine until somebody is standing on
  // something that is for sale.
  for (let guard = 0; guard < 400 && game.view().pending.kind !== "buy"; guard++) {
    const who = game.waitingOn();
    assert(who, "outside an auction the board always waits on somebody");
    game.autoMove(who);
  }
  assertEquals(game.view().pending.kind, "buy", "somebody reached a square on the market");
  game.decline(game.view().pending.playerId!);

  const open = t.room.monoView()!;
  assert(open.auction, "refusing it put it up");
  assertEquals(open.waitingOn, null, "with no one player to name");
  assert(open.autoAt !== null, "but a fuse the browser can count down");

  // The bug: nothing answered for a bidder who never bids, so the room sat here
  // forever. Every bidder can be answered for now, one at a time, exactly as the
  // room's own timer does it.
  for (let guard = 0; guard < 10 && game.view().auction; guard++) {
    const ids = game.waitingIds();
    assert(ids.length > 0, "an open auction is waiting on somebody");
    game.autoMove(ids[0]);
  }
  assertEquals(game.view().auction, null, "the hammer fell without anybody bidding");
});

Deno.test("one no is enough to keep a game going", async () => {
  const t = await makeRoom({ mode: "monopoly" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  const before = t.room.mono;
  t.room.monoRestartAsk(idFor("ann"));
  t.room.monoRestartVote(idFor("bo"), false);
  assertEquals(t.room.mono, before, "same game");
  assertEquals(t.room.viewFor(idFor("ann")).mono?.restart, null, "and the vote is closed");
});

Deno.test("the host can load a board, and is told what is wrong when it will not load", async () => {
  const t = await makeRoom({ mode: "monopoly" }, ["ann", "bo"]);
  const host = idFor("ann");

  const bad = t.room.loadMonoMap(host, { name: "Thiếu", places: ["chỉ một"] });
  assertEquals(bad.ok, false);
  assert(bad.errors.length > 1, "every problem at once, not one per round-trip");

  const good = t.room.loadMonoMap(host, {
    name: "Phố nhà tôi",
    icon: "🏘️",
    places: Array.from({ length: 22 }, (_, i) => ({ name: `Ngõ ${i + 1}`, icon: "📍" })),
    transport: ["Bến một", "Bến hai", "Bến ba", "Bến bốn"],
    utilities: ["Điện", "Nước"],
    groups: Array.from({ length: 8 }, (_, i) => ({ name: `Khu ${i + 1}` })),
  });
  assertEquals(good.errors, []);
  assertEquals(good.ok, true);
  assertEquals(t.room.config.monoMap, "custom");
  assertEquals(t.room.monoMap().name, "Phố nhà tôi");

  // And it is the board actually played on.
  t.room.start(host);
  assertEquals(t.room.viewFor(host).mono?.map.name, "Phố nhà tôi");
});

Deno.test("only the host may load a board, and not mid-game", async () => {
  const t = await makeRoom({ mode: "monopoly" }, ["ann", "bo"]);
  assertThrows(() => t.room.loadMonoMap(idFor("bo"), {}), RoomError, "Only the host");
  t.room.start(idFor("ann"));
  const result = t.room.loadMonoMap(idFor("ann"), { name: "Muộn" });
  assertEquals(result.ok, false);
  assert(result.errors[0].includes("đang chạy"));
});

Deno.test("standings rank by net worth and name the piece", async () => {
  const t = await makeRoom({ mode: "monopoly" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  const standings = t.room.standings();
  assertEquals(standings.length, 2);
  for (const row of standings) {
    assertEquals(row.score, 1500);
    assert(row.detail.includes("tiền mặt"), `detail should quote cash, got ${row.detail}`);
  }
});

// The README points at this file as the worked example of a hand-written board,
// so it has to keep loading. A broken example is worse than no example: it teaches
// the format wrong and the first thing anybody does with it is load it.
Deno.test("the example board shipped in data/ loads clean", async () => {
  const raw = JSON.parse(await Deno.readTextFile("data/monopoly/hoi-an.json"));
  const result = normaliseMap(raw);
  assertEquals(result.errors, [], "the shipped example should have nothing wrong with it");
  assertEquals(result.map.spaces.length, 40);
  assertEquals(result.map.name, "Hội An");

  // And it plays: the compact form has to come out as a board, not just validate.
  const h = harness(["a", "b"], {}, result.map);
  h.roll(3, 2);
  assertEquals(h.pos(h.order[0]), 5);
  assertEquals(h.game.view().spaces[5].name, "Bến xe Hội An", "square 5 is a transport square");
});

// ---------------------------------------------------------------------------
// The pictures
// ---------------------------------------------------------------------------

// Every square draws itself, so every square needs a picture that exists. A
// typo in a scene name is invisible on the board — the square just falls back to
// a street — which is exactly why it has to be caught here instead.
Deno.test("every square of every built-in board names a picture that exists", () => {
  for (const id of BUILTIN_MAP_IDS) {
    const map = builtinMap(id);
    for (const space of map.spaces) {
      assert(space.scene, `${id} square ${space.index} (${space.name}) has no picture`);
      assert(
        Object.hasOwn(SCENES, space.scene),
        `${id} square ${space.index} (${space.name}) names “${space.scene}”, which is not a picture`,
      );
    }
  }
});

// The smallest thing that loads: 22 named places, 4 transport, 2 utilities and
// 8 groups. Returned fresh each call so a test can spoil one field of it.
function rawCompact() {
  return {
    name: "Bàn hình",
    icon: "🖼️",
    places: Array.from(
      { length: 22 },
      (_, i) => ({ name: `Ngõ ${i + 1}`, icon: "📍", scene: "" }),
    ),
    transport: ["Bến một", "Bến hai", "Bến ba", "Bến bốn"],
    utilities: ["Điện", "Nước"],
    groups: Array.from({ length: 8 }, (_, i) => ({ name: `Khu ${i + 1}` })),
  };
}

// A misspelt picture name must not cost somebody their whole board. Twenty-two
// street names are an evening's work; one bad word in them is a note, not a
// rejection, so the board loads with the default drawing on that square.
Deno.test("an unknown picture name is a warning, not a rejected board", () => {
  const raw = rawCompact();
  raw.places[0].scene = "khongcohinhnaotennay";
  const result = normaliseMap(raw);
  assertEquals(result.errors, []);
  assertEquals(result.ok, true);
  assertEquals(result.warnings.length, 1);
  assert(
    result.warnings[0].includes("khongcohinhnaotennay"),
    `the warning should quote the bad name, got ${result.warnings[0]}`,
  );
  const first = result.map.spaces[1];
  assert(Object.hasOwn(SCENES, first.scene), "the square still gets a picture");

  // And a good name is taken as given, with nothing to warn about.
  raw.places[0].scene = "denlong";
  const good = normaliseMap(raw);
  assertEquals(good.warnings, []);
  assertEquals(good.map.spaces[1].scene, "denlong");
});

// The middle of the board is the one place a picture is the size of a picture, so
// a board that forgot to name an emblem must still fill it.
Deno.test("the middle of the board gets an emblem, named or inferred", () => {
  assertEquals(builtinMap("vietnam").scene, "bandovn");
  for (const id of BUILTIN_MAP_IDS) {
    const map = builtinMap(id);
    assert(Object.hasOwn(SCENES, map.scene), `${id} names no emblem that exists: ${map.scene}`);
  }

  // Nothing named: the dearest square's picture stands in for the board.
  const raw = rawCompact();
  raw.places[21].scene = "hoangthanh";
  const quiet = normaliseMap(raw);
  assertEquals(quiet.warnings, []);
  assertEquals(quiet.map.scene, "hoangthanh");

  // Named, and named badly: a warning, and the dearest square again.
  const named = normaliseMap({ ...rawCompact(), scene: "bandovn" });
  assertEquals(named.map.scene, "bandovn");
  const bad = normaliseMap({ ...rawCompact(), scene: "khongphaihinh" });
  assertEquals(bad.ok, true);
  assertEquals(bad.warnings.length, 1);
  assert(Object.hasOwn(SCENES, bad.map.scene));
});

// The browser animates a throw when this number changes, so two identical throws
// in a row have to be distinguishable — that is the whole reason it exists.
Deno.test("every throw is counted, including two that land the same", () => {
  const h = harness(["a", "b"]);
  assertEquals(h.game.view().rollNo, 0);

  h.roll(3, 4);
  assertEquals(h.game.view().rollNo, 1);
  const first = h.game.view().dice;

  done(h, h.order[0]);
  h.roll(3, 4);
  const second = h.game.view();
  assertEquals(second.dice, first, "the same faces...");
  assertEquals(second.rollNo, 2, "...but not the same throw");

  // A throw nobody made does not count: ending a turn clears the dice and leaves
  // the tally where it was, so an idle snapshot never re-animates.
  done(h, second.turnId!);
  assertEquals(h.game.view().dice, null);
  assertEquals(h.game.view().rollNo, 2);
});

// ---------------------------------------------------------------------------
// Money that stays money
// ---------------------------------------------------------------------------

// Stations and utilities have no house price, so anything that multiplies a
// building count by one has to say so — `0 * undefined` is NaN, JSON sends NaN
// as null, and every comparison against it is silently false. This showed up as
// a "null" where a net worth should be, on a board where somebody had bought an
// airport.
Deno.test("owning a station leaves every sum a number", () => {
  const h = harness(["a", "b"], {}, builtinMap("vietnam"));
  const [first] = h.order;

  h.roll(2, 3);
  assertEquals(h.game.view().spaces[5].kind, "transport");
  h.game.buy(first);

  const me = h.game.view().players.find((p) => p.id === first)!;
  assert(Number.isFinite(me.net), `net worth is ${me.net}, not a number`);
  assertEquals(me.net, 1500, "cash spent on a deed is still worth its price");

  // The same number over the wire, where NaN would arrive as null.
  const wire = JSON.parse(JSON.stringify(h.game.view()));
  assertEquals(wire.players.find((p: { id: string }) => p.id === first).net, 1500);
});
// #liquid decides whether somebody may declare bankruptcy at all: a player who
// could mortgage their way out is told to. A NaN there makes `liquid >= debt`
// false, which would hand anybody holding a station a way to walk away from a
// debt they can pay.
Deno.test("a station in hand is cash you have not raised yet", () => {
  const map = testMap();
  // A bill just past what the wallet holds once a station has been bought, so
  // the debt machinery engages with mortgageable property on the table.
  map.spaces[8] = { kind: "tax", name: "Thuế lớn", icon: "🧾", amount: 1350 };
  const h = harness(["a", "b"], {}, map);
  const [first, second] = h.order;

  h.roll(2, 3); // -> square 5, the station
  assertEquals(h.game.view().spaces[5].kind, "transport");
  buy(h);
  done(h, first);
  assertEquals(h.cash(first), 1300);

  take(h, 3, 4); // the other player, out of the way
  assertEquals(h.game.view().turnId, first);

  h.roll(1, 2); // -> square 8, the bill
  const pending = h.game.view().pending;
  assertEquals(pending.kind, "debt", "1.350 out of 1.300 in cash is a debt");

  // 1.300 in cash plus 100 for mortgaging the station clears 1.350, so the game
  // must refuse the bankruptcy and say what to do instead.
  assertThrows(() => h.game.declareBankrupt(first), MonopolyError, "Bạn vẫn còn đủ tài sản");

  // And the way out actually works: mortgaging clears the debt on the spot.
  h.game.mortgage(first, 5);
  assertEquals(h.game.view().pending.kind === "debt", false, "the debt is settled");
  assert(Number.isFinite(h.cash(first)), "cash is still a number");
  assertEquals(h.cash(first), 50, "1.300 + 100 mortgaged, less the 1.350 bill");
  assertEquals(h.cash(second), 1500, "a tax goes to the bank, not to the other player");
});

// ---------------------------------------------------------------------------
// The ring
//
// `ringPosition` used to live in the client and be read by one caller. It is now
// shared, because two boards read it — the CSS grid puts a square at a row and a
// column, and the 3D board turns the same row and column into a place in the
// world. If it drifts, they drift apart, so it is pinned here.
// ---------------------------------------------------------------------------

Deno.test("every square of the ring gets its own cell, on an edge, all the way round", () => {
  for (const total of [40, 28, 20]) {
    const side = (total + 4) / 4;
    const seen = new Set<string>();
    for (let i = 0; i < total; i++) {
      const { row, col } = ringPosition(i, total);
      assert(
        row >= 1 && row <= side && col >= 1 && col <= side,
        `square ${i} of ${total} is off the board at ${row},${col}`,
      );
      assert(
        row === 1 || row === side || col === 1 || col === side,
        `square ${i} of ${total} is not on an edge: ${row},${col}`,
      );
      const key = `${row},${col}`;
      assert(!seen.has(key), `two squares share ${key} on a ${total}-square board`);
      seen.add(key);
    }
    assertEquals(seen.size, total, "every square placed exactly once");
  }
});

Deno.test("the ring starts in the corner and runs the way the board is drawn", () => {
  const total = 40;
  const side = 11;
  // Xuất phát is the bottom-right corner, and the first leg runs right to left
  // along the bottom, which is the direction a Monopoly board is played in.
  assertEquals(ringPosition(0, total), { row: side, col: side, edge: "corner" });
  assertEquals(ringPosition(1, total).row, side);
  assertEquals(ringPosition(1, total).col, side - 1);
  // The other three corners land on the other three corners.
  assertEquals(ringPosition(10, total), { row: side, col: 1, edge: "corner" });
  assertEquals(ringPosition(20, total), { row: 1, col: 1, edge: "corner" });
  assertEquals(ringPosition(30, total), { row: 1, col: side, edge: "corner" });
  // And the last square is back beside the first, one step short of the corner.
  assertEquals(ringPosition(39, total), { row: side - 1, col: side, edge: "right" });
});

Deno.test("consecutive squares are always neighbours", () => {
  const total = 40;
  for (let i = 0; i < total; i++) {
    const a = ringPosition(i, total);
    const b = ringPosition((i + 1) % total, total);
    const step = Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
    assertEquals(step, 1, `square ${i} and ${(i + 1) % total} are not adjacent`);
  }
});
