// The Monopoly board: its shape, its money, and how a map file becomes one.
//
// Plain JS like shared/constants.js, because both the Deno server and the
// browser import this file directly. The server is the only authority on *play*
// — see server/monopoly.ts — but both sides need to agree on what a space is,
// what it costs and what it is called, so all of that lives here.
//
// Two things are deliberately separated:
//
//   * the **layout** — where the 40 squares sit, what each one costs, and the
//     rent ladder on it. Fixed, identical for every map, and not something a map
//     file gets to touch. A board where one street quietly rents for twice as
//     much is not a variant, it is a broken game, and balancing a fresh
//     22-square rent table is not work to ask of somebody naming streets.
//   * the **place names** — which locality the board is, and what the 22
//     properties, 4 transport squares and 2 utilities are called there. That is
//     the whole of a map file, which is why writing one is an afternoon of local
//     knowledge rather than a spreadsheet of numbers.
//
// So a map says "these are the streets of Hà Nội, cheapest first" and gets a
// balanced classic board back. `normaliseMap` also accepts a fully explicit
// 40-square form for anyone who does want to move the furniture.

import { emblemFor, sceneFor, SCENES } from "./monopoly_art.js";

/** Bump when a change would make an older map file play differently. */
export const MAP_SCHEMA = "closeword-monopoly-map/1";

/** @typedef {"go"|"place"|"transport"|"utility"|"chance"|"chest"|"tax"|"jail"|"parking"|"gotojail"} SpaceKind */

export const BOARD_SIZE = 40;

/**
 * The 22 buyable places, cheapest first, with the classic rent ladder.
 *
 * `rent` is [trần, 1 nhà, 2 nhà, 3 nhà, 4 nhà, khách sạn]. Bare rent doubles
 * when one owner holds the whole colour group and has built nothing — that
 * doubling is computed at rent time, not stored here.
 */
export const PLACE_LADDER = [
  { price: 60, rent: [2, 10, 30, 90, 160, 250], house: 50 },
  { price: 60, rent: [4, 20, 60, 180, 320, 450], house: 50 },
  { price: 100, rent: [6, 30, 90, 270, 400, 550], house: 50 },
  { price: 100, rent: [6, 30, 90, 270, 400, 550], house: 50 },
  { price: 120, rent: [8, 40, 100, 300, 450, 600], house: 50 },
  { price: 140, rent: [10, 50, 150, 450, 625, 750], house: 100 },
  { price: 140, rent: [10, 50, 150, 450, 625, 750], house: 100 },
  { price: 160, rent: [12, 60, 180, 500, 700, 900], house: 100 },
  { price: 180, rent: [14, 70, 200, 550, 750, 950], house: 100 },
  { price: 180, rent: [14, 70, 200, 550, 750, 950], house: 100 },
  { price: 200, rent: [16, 80, 220, 600, 800, 1000], house: 100 },
  { price: 220, rent: [18, 90, 250, 700, 875, 1050], house: 150 },
  { price: 220, rent: [18, 90, 250, 700, 875, 1050], house: 150 },
  { price: 240, rent: [20, 100, 300, 750, 925, 1100], house: 150 },
  { price: 260, rent: [22, 110, 330, 800, 975, 1150], house: 150 },
  { price: 260, rent: [22, 110, 330, 800, 975, 1150], house: 150 },
  { price: 280, rent: [24, 120, 360, 850, 1025, 1200], house: 150 },
  { price: 300, rent: [26, 130, 390, 900, 1100, 1275], house: 200 },
  { price: 300, rent: [26, 130, 390, 900, 1100, 1275], house: 200 },
  { price: 320, rent: [28, 150, 450, 1000, 1200, 1400], house: 200 },
  { price: 350, rent: [35, 175, 500, 1100, 1300, 1500], house: 200 },
  { price: 400, rent: [50, 200, 600, 1400, 1700, 2000], house: 200 },
];

/** Board index of each of the 22 places, in the same order as `PLACE_LADDER`. */
export const PLACE_SLOTS = [
  1,
  3,
  6,
  8,
  9,
  11,
  13,
  14,
  16,
  18,
  19,
  21,
  23,
  24,
  26,
  27,
  29,
  31,
  32,
  34,
  37,
  39,
];

/** How many places each of the 8 colour groups holds, in price order. */
export const GROUP_SIZES = [2, 3, 3, 3, 3, 3, 3, 2];

export const TRANSPORT_SLOTS = [5, 15, 25, 35];
export const UTILITY_SLOTS = [12, 28];
export const CHANCE_SLOTS = [7, 22, 36];
export const CHEST_SLOTS = [2, 17, 33];

export const GO_SLOT = 0;
export const JAIL_SLOT = 10;
export const PARKING_SLOT = 20;
export const GOTO_JAIL_SLOT = 30;
export const INCOME_TAX_SLOT = 4;
export const LUXURY_TAX_SLOT = 38;

export const TRANSPORT_PRICE = 200;
/** Rent by how many transport squares the same owner holds. */
export const TRANSPORT_RENT = [25, 50, 100, 200];

export const UTILITY_PRICE = 150;
/** Multiplier on the dice roll, by how many utilities the owner holds. */
export const UTILITY_MULTIPLIER = [4, 10];

export const MAX_HOUSES = 4;

/**
 * Where square `i` sits on the ring, as 1-based grid coordinates.
 *
 * Derived from the square count rather than hard-coded for 40, so a board of a
 * different size still lands on a ring instead of a heap. The four corners are
 * special-cased because they are the only squares that belong to two edges.
 *
 * Shared, because two boards draw from it: the CSS grid puts a square at
 * `grid-row`/`grid-column`, and the 3D board turns the same row and column into
 * world coordinates. Deriving them separately is how the two would drift apart.
 */
export function ringPosition(i, total) {
  const side = (total + 4) / 4;
  const last = side;
  const leg = side - 1;
  if (i === 0) return { row: last, col: last, edge: "corner" };
  if (i < leg) return { row: last, col: last - i, edge: "bottom" };
  if (i === leg) return { row: last, col: 1, edge: "corner" };
  if (i < 2 * leg) return { row: last - (i - leg), col: 1, edge: "left" };
  if (i === 2 * leg) return { row: 1, col: 1, edge: "corner" };
  if (i < 3 * leg) return { row: 1, col: i - 2 * leg + 1, edge: "top" };
  if (i === 3 * leg) return { row: 1, col: last, edge: "corner" };
  return { row: i - 3 * leg + 1, col: last, edge: "right" };
}

/** How many turns in jail before the bail is simply taken and you walk out. */
export const JAIL_TURNS = 3;

/**
 * One hue per seat, in the order seats are dealt.
 *
 * Assigned by seat rather than hashed from the player id, because a hash
 * collides: two of three people in a room came out green, which is the one
 * thing a player colour must never do. Eight seats, eight hues, spread far
 * enough apart to tell neighbours apart at the size of a piece on a square.
 * Saturation and lightness still come from the theme, so a hue reads in dark.
 *
 * Ordered so that the *first* seats are the furthest apart rather than the whole
 * set being evenly spread: three people is the common case, and red, blue, green
 * is unmistakable where red, orange, yellow is not.
 */
export const SEAT_HUES = [6, 212, 128, 32, 268, 172, 52, 318];

/**
 * The rarity ladder Khí vận is drawn against, rarest last.
 *
 * Khí vận used to be sixteen cards stepped through in a shuffled order, which
 * is the printed rule and is also the dullest square on the board: a fixed pile
 * of small numbers, and after two laps you knew what was left in it. It is a
 * lucky draw now — weighted by tier, drawn fresh every time, so the same card
 * can come twice and the good ones stay rare enough to be worth shouting about.
 *
 * The weights are per tier rather than per card, and cards inside a tier are
 * equally likely, so adding a card changes what that tier is likely to *be*
 * without changing how often a legendary turns up.
 */
export const CHEST_TIERS = [
  { id: "common", name: "Thường", icon: "⚪", weight: 56 },
  { id: "rare", name: "Hiếm", icon: "🔵", weight: 28 },
  { id: "epic", name: "Cực hiếm", icon: "🟣", weight: 13 },
  { id: "legend", name: "Truyền thuyết", icon: "🌟", weight: 3 },
];

/** Tier of a card that does not name one — a map may ship a deck with no tiers at all. */
export const DEFAULT_TIER = "common";

/**
 * Draw one Khí vận card: a tier by weight, then a card inside it.
 *
 * Weighting the tier rather than the card is what keeps the odds steady while the
 * deck changes — adding a legendary changes *which* legendary you get, not how
 * often you get one. A deck that names no tiers at all, which is any map written
 * before rarities existed, lands wholly in `common` and comes back out as a plain
 * uniform draw: the sane reading of a deck with no rarities in it.
 *
 * Here rather than in the engine because it is a fact about the deck, and because
 * odds that nobody can test are odds nobody should trust.
 */
export function drawChestCard(cards, random) {
  const buckets = CHEST_TIERS
    .map((tier) => ({ tier, cards: cards.filter((c) => (c.tier ?? DEFAULT_TIER) === tier.id) }))
    .filter((bucket) => bucket.cards.length > 0);
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  if (buckets.length === 0) return pick(cards);

  const total = buckets.reduce((sum, bucket) => sum + bucket.tier.weight, 0);
  let roll = random() * total;
  for (const bucket of buckets) {
    roll -= bucket.tier.weight;
    if (roll <= 0) return pick(bucket.cards);
  }
  return pick(buckets[buckets.length - 1].cards);
}

/**
 * How long the board waits on somebody before it plays their move for them.
 *
 * Two deadlines, because the two waits are not the same thing. A decision only
 * they can make — buy, tax, bail, a debt — is worth twenty seconds. The tail of
 * a turn, where the only thing left is to say "done", is not: everybody else is
 * watching a screen where nothing is happening.
 */
export const AUTO_IDLE_MS = 20_000;
export const AUTO_END_MS = 12_000;
/** Between two moves the machine makes, so a run of them stays watchable. */
export const AUTO_STEP_MS = 1100;

/**
 * Money, and the words for it.
 *
 * The classic numbers with a "K" (nghìn) suffix rather than a redenominated
 * table: the ratios between 60 and 400 and 1.500 are what eighty years of play
 * balanced, and rewriting them into round millions would quietly change the
 * game. A map may override any of these, so an author who wants triệu can have
 * it.
 */
export const DEFAULT_MONEY = {
  unit: "K",
  /** Starting cash. */
  start: 1500,
  /** Salary for passing Xuất phát. */
  go: 200,
  /** What it costs to buy your way out of Nhà tù. */
  bail: 50,
};

/**
 * The two card decks, written once and reused by every map.
 *
 * Targets are *ranks* rather than board indices — "the dearest place", "the
 * mid-table one" — so one deck is correct on every map, including a map somebody
 * writes tonight for their own district. A map may still ship its own decks.
 *
 * Effects, all of them:
 *   {k:"cash",   amount}            +ve receive from the bank, -ve pay it
 *   {k:"each",   amount}            +ve every other player pays you, -ve you pay them
 *   {k:"toGo"}                      straight to Xuất phát, salary collected
 *   {k:"toRank", rank}              to a place by price rank, passing GO if you do
 *   {k:"back",   steps}             backwards, and no salary for it
 *   {k:"jail"}                      do not pass Xuất phát
 *   {k:"freeJail"}                  keep the card until you need it
 *   {k:"nearest", target, factor}   nearest transport/utility, rent × factor
 *   {k:"repairs", house, hotel}     per building you own
 *   {k:"nudge",   steps}            forwards on foot, salary collected if you pass
 *   {k:"jackpot", amount}           the pot in the middle, or `amount` when it is off
 *   {k:"shield"}                    the next rent you owe is waived
 *   {k:"freeBuild"}                 one building, free, on your cheapest place
 *   {k:"sellBuilding"}              one of your buildings back to the bank at half price
 *   {k:"giveDeed"}                  your cheapest deed to whoever is worth least
 *   {k:"swapDeed"}                  your cheapest deed for the richest player's cheapest
 *
 * The last four are the funny ones, and all four are deliberately *decided* by
 * the board rather than chosen by the player: a card that opened a picker would
 * be a card that stops the table while somebody reads their own deeds.
 */
export const CHANCE_CARDS = [
  { icon: "🏁", text: "Về ô Xuất phát và nhận lương.", effect: { k: "toGo" } },
  {
    icon: "🌆",
    text: "Tiến tới địa điểm đắt nhất trên bàn. Chưa ai mua thì bạn được mua.",
    effect: { k: "toRank", rank: 0 },
  },
  {
    icon: "🏬",
    text: "Tiến tới địa điểm đắt thứ hai. Chưa ai mua thì bạn được mua.",
    effect: { k: "toRank", rank: 1 },
  },
  {
    icon: "🏫",
    text: "Tiến tới một địa điểm hạng trung. Chưa ai mua thì bạn được mua.",
    effect: { k: "toRank", rank: 11 },
  },
  {
    icon: "🏘️",
    text: "Tiến tới một địa điểm vùng ven. Chưa ai mua thì bạn được mua.",
    effect: { k: "toRank", rank: 18 },
  },
  {
    icon: "⚡",
    text: "Tới ô tiện ích gần nhất. Nếu có chủ, trả gấp 10 lần số xúc xắc.",
    effect: { k: "nearest", target: "utility", factor: 10 },
  },
  {
    icon: "🚆",
    text: "Tới ô giao thông gần nhất. Nếu có chủ, trả gấp đôi tiền thuê.",
    effect: { k: "nearest", target: "transport", factor: 2 },
  },
  {
    icon: "🚉",
    text: "Tới ô giao thông gần nhất. Nếu có chủ, trả gấp đôi tiền thuê.",
    effect: { k: "nearest", target: "transport", factor: 2 },
  },
  { icon: "🧧", text: "Ngân hàng trả cổ tức cho bạn: nhận 50.", effect: { k: "cash", amount: 50 } },
  { icon: "🎫", text: "Thẻ ra tù miễn phí — giữ lại đến khi cần.", effect: { k: "freeJail" } },
  { icon: "↩️", text: "Lùi lại 3 ô.", effect: { k: "back", steps: 3 } },
  {
    icon: "🚔",
    text: "Vào tù ngay! Không qua ô Xuất phát, không nhận lương.",
    effect: { k: "jail" },
  },
  {
    icon: "🛠️",
    text: "Sửa chữa nhà cửa: trả 25 mỗi nhà và 100 mỗi khách sạn.",
    effect: { k: "repairs", house: 25, hotel: 100 },
  },
  { icon: "⛽", text: "Giá xăng dầu tăng: trả 15.", effect: { k: "cash", amount: -15 } },
  {
    icon: "🪙",
    text: "Bạn được bầu làm chủ tịch hội đồng: trả mỗi người 50.",
    effect: { k: "each", amount: -50 },
  },
  {
    icon: "🏗️",
    text: "Trái phiếu xây dựng đáo hạn: nhận 150.",
    effect: { k: "cash", amount: 150 },
  },
];

/**
 * Khí vận: the lucky draw.
 *
 * Every card carries the tier it is drawn at. The common ones are the small
 * change a board game runs on; the rare ones are the printed deck's real events;
 * the top two tiers are the reason anybody wants to land here — they move deeds
 * between players, knock a building down, or hand one over for free.
 */
export const CHEST_CARDS = [
  // --- Thường -------------------------------------------------------------
  { tier: "common", icon: "💼", text: "Phí tư vấn: nhận 25.", effect: { k: "cash", amount: 25 } },
  {
    tier: "common",
    icon: "🍜",
    text: "Thắng giải thi nấu ăn của khu phố: nhận 10.",
    effect: { k: "cash", amount: 10 },
  },
  {
    tier: "common",
    icon: "🏦",
    text: "Lãi tiền gửi tiết kiệm: nhận 25.",
    effect: { k: "cash", amount: 25 },
  },
  {
    tier: "common",
    icon: "💰",
    text: "Hoàn thuế: nhận 20.",
    effect: { k: "cash", amount: 20 },
  },
  {
    tier: "common",
    icon: "🌾",
    text: "Nông sản được giá: nhận 100.",
    effect: { k: "cash", amount: 100 },
  },
  {
    tier: "common",
    icon: "🏥",
    text: "Tiền thuốc: trả 50.",
    effect: { k: "cash", amount: -50 },
  },
  {
    tier: "common",
    icon: "🎗️",
    text: "Quyên góp từ thiện: trả 50.",
    effect: { k: "cash", amount: -50 },
  },
  {
    tier: "common",
    icon: "☕",
    text: "Khao cả bàn một vòng cà phê: trả mỗi người 10.",
    effect: { k: "each", amount: -10 },
  },

  // --- Hiếm ---------------------------------------------------------------
  {
    tier: "rare",
    icon: "🧧",
    text: "Ngân hàng nhầm có lợi cho bạn: nhận 200.",
    effect: { k: "cash", amount: 200 },
  },
  {
    tier: "rare",
    icon: "🎂",
    text: "Sinh nhật bạn! Mỗi người tặng bạn 10.",
    effect: { k: "each", amount: 10 },
  },
  {
    tier: "rare",
    icon: "🎫",
    text: "Thẻ ra tù miễn phí — giữ lại đến khi cần.",
    effect: { k: "freeJail" },
  },
  {
    tier: "rare",
    icon: "💊",
    text: "Chi phí bệnh viện: trả 100.",
    effect: { k: "cash", amount: -100 },
  },
  {
    tier: "rare",
    icon: "📚",
    text: "Học phí đầu năm: trả 150.",
    effect: { k: "cash", amount: -150 },
  },
  {
    tier: "rare",
    icon: "🚕",
    text: "Bác xe ôm nhiệt tình quá: đi thêm 3 ô.",
    effect: { k: "nudge", steps: 3 },
  },
  {
    tier: "rare",
    icon: "🧱",
    text: "Đánh giá lại bất động sản: trả 40 mỗi nhà và 115 mỗi khách sạn.",
    effect: { k: "repairs", house: 40, hotel: 115 },
  },
  {
    tier: "rare",
    icon: "🚔",
    text: "Vào tù ngay! Không qua ô Xuất phát, không nhận lương.",
    effect: { k: "jail" },
  },

  // --- Cực hiếm -----------------------------------------------------------
  {
    tier: "epic",
    icon: "🎰",
    text: "Vét hũ giữa bàn! Không có hũ thì ngân hàng trả 150.",
    effect: { k: "jackpot", amount: 150 },
  },
  {
    tier: "epic",
    icon: "🧨",
    text: "Giải toả mặt bằng: buộc bán một công trình của bạn cho ngân hàng, nửa giá.",
    effect: { k: "sellBuilding" },
  },
  {
    tier: "epic",
    icon: "🎁",
    text: "Nghĩa tình khu phố: trao ô rẻ nhất của bạn cho người ít tài sản nhất bàn.",
    effect: { k: "giveDeed" },
  },
  {
    tier: "epic",
    icon: "🔄",
    text: "Đổi nhà cho vui: ô rẻ nhất của bạn đổi với ô rẻ nhất của người giàu nhất.",
    effect: { k: "swapDeed" },
  },
  {
    tier: "epic",
    icon: "🏁",
    text: "Xe đưa bạn về ô Xuất phát, và nhận lương.",
    effect: { k: "toGo" },
  },

  // --- Truyền thuyết ------------------------------------------------------
  { tier: "legend", icon: "💎", text: "Lô độc đắc: nhận 500!", effect: { k: "cash", amount: 500 } },
  {
    tier: "legend",
    icon: "🏗️",
    text: "Trúng thưởng xây dựng: một công trình miễn phí trên ô rẻ nhất của bạn.",
    effect: { k: "freeBuild" },
  },
  {
    tier: "legend",
    icon: "🛡️",
    text: "Có người bảo kê: lần tới phải trả tiền thuê, bạn được miễn.",
    effect: { k: "shield" },
  },
];

/** The four corners and the two tax squares, named the same way on every map. */
export const FIXED_SPACES = {
  go: { name: "Xuất phát", icon: "🏁", note: "Qua đây thì nhận lương" },
  jail: { name: "Tạm giam", icon: "🚔", note: "Chỉ ghé qua — trừ khi bạn đang ở tù" },
  parking: { name: "Bãi đỗ xe miễn phí", icon: "🅿️", note: "Nghỉ chân, không mất gì" },
  gotojail: { name: "Vào tù ngay!", icon: "👮", note: "Không qua Xuất phát, không nhận lương" },
  chance: { name: "Cơ hội", icon: "🎲", note: "Rút một lá và làm theo" },
  chest: { name: "Khí vận", icon: "🧧", note: "Rút một lá và làm theo" },
  income: { name: "Thuế thu nhập", icon: "🧾", note: "Trả 200, hoặc 10% tổng tài sản" },
  luxury: { name: "Thuế xa xỉ", icon: "💎", note: "Trả 100" },
};

export const INCOME_TAX_FLAT = 200;
export const INCOME_TAX_PERCENT = 10;
export const LUXURY_TAX = 100;

export const DEFAULT_GROUP_COLORS = [
  "#8d6e4a",
  "#7fc3e8",
  "#d96a9c",
  "#e8913c",
  "#d0483c",
  "#e8c53c",
  "#4fa86a",
  "#2f5fb0",
];

// ---------------------------------------------------------------------------
// Building a board
// ---------------------------------------------------------------------------

/**
 * Expand a compact map spec into the explicit 40-square board.
 *
 * `spec.places` is 22 entries cheapest first, `spec.groups` is 8 group labels,
 * `spec.transport` is 4 and `spec.utilities` is 2. Everything numeric comes from
 * the ladder above, so a map author never types a price.
 *
 * @param {object} spec
 * @returns {object} a normalised map
 */
export function buildBoard(spec) {
  const groups = spec.groups.map((g, i) => ({
    id: g.id ?? `g${i}`,
    name: g.name,
    icon: g.icon ?? "",
    color: g.color ?? DEFAULT_GROUP_COLORS[i],
  }));

  // Which group each of the 22 places belongs to, derived from GROUP_SIZES so
  // the two tables cannot drift apart.
  const groupOfPlace = [];
  GROUP_SIZES.forEach((size, gi) => {
    for (let n = 0; n < size; n++) groupOfPlace.push(groups[gi].id);
  });

  const spaces = new Array(BOARD_SIZE);

  spaces[GO_SLOT] = { kind: "go", ...FIXED_SPACES.go };
  spaces[JAIL_SLOT] = { kind: "jail", ...FIXED_SPACES.jail };
  spaces[PARKING_SLOT] = { kind: "parking", ...FIXED_SPACES.parking };
  spaces[GOTO_JAIL_SLOT] = { kind: "gotojail", ...FIXED_SPACES.gotojail };
  for (const i of CHANCE_SLOTS) spaces[i] = { kind: "chance", ...FIXED_SPACES.chance };
  for (const i of CHEST_SLOTS) spaces[i] = { kind: "chest", ...FIXED_SPACES.chest };
  spaces[INCOME_TAX_SLOT] = {
    kind: "tax",
    ...FIXED_SPACES.income,
    amount: INCOME_TAX_FLAT,
    percent: INCOME_TAX_PERCENT,
  };
  spaces[LUXURY_TAX_SLOT] = { kind: "tax", ...FIXED_SPACES.luxury, amount: LUXURY_TAX };

  PLACE_SLOTS.forEach((slot, n) => {
    const place = spec.places[n];
    const rung = PLACE_LADDER[n];
    spaces[slot] = {
      kind: "place",
      name: place.name,
      icon: place.icon ?? "📍",
      note: place.note ?? "",
      scene: sceneFor("place", place.scene, n),
      group: groupOfPlace[n],
      price: rung.price,
      rent: [...rung.rent],
      house: rung.house,
    };
  });

  TRANSPORT_SLOTS.forEach((slot, n) => {
    const t = spec.transport[n];
    spaces[slot] = {
      kind: "transport",
      name: t.name,
      icon: t.icon ?? "🚉",
      note: t.note ?? "",
      scene: sceneFor("transport", t.scene, n),
      price: TRANSPORT_PRICE,
    };
  });

  UTILITY_SLOTS.forEach((slot, n) => {
    const u = spec.utilities[n];
    spaces[slot] = {
      kind: "utility",
      name: u.name,
      icon: u.icon ?? "⚡",
      note: u.note ?? "",
      scene: sceneFor("utility", u.scene, n),
      price: UTILITY_PRICE,
    };
  });

  // The squares nobody buys get their picture from their kind — there is exactly
  // one sensible drawing for "go to jail", so it is not worth a field.
  for (const space of spaces) if (!space.scene) space.scene = sceneFor(space.kind, null);

  return {
    schema: MAP_SCHEMA,
    id: spec.id,
    name: spec.name,
    icon: spec.icon ?? "🗺️",
    region: spec.region ?? "",
    note: spec.note ?? "",
    // The picture for the hole in the middle: the board itself, drawn large.
    scene: emblemFor(spec.scene, spaces[PLACE_SLOTS[PLACE_SLOTS.length - 1]].scene),
    money: { ...DEFAULT_MONEY, ...(spec.money ?? {}) },
    groups,
    spaces,
    chance: spec.chance ?? CHANCE_CARDS,
    chest: spec.chest ?? CHEST_CARDS,
  };
}

// ---------------------------------------------------------------------------
// Reading a map somebody else wrote
// ---------------------------------------------------------------------------

const MAX_NAME = 40;
const MAX_NOTE = 90;
const MAX_ICON = 8;
/** Cards in one deck. Sixteen is the printed number; this is room to play with. */
const MAX_CARDS = 64;

/** Control characters, which a one-line street name has no use for. */
const CONTROL_RE = /[\p{Cc}\p{Cf}]/gu;
/** Combining marks, stripped only to slugify a name into an id. */
const MARKS_RE = /\p{M}/gu;

function text(value, max, fallback = "") {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : fallback;
}

/**
 * Turn whatever was in the file into a board, or say why it cannot be one.
 *
 * Every message is in Vietnamese and names the field, because the person reading
 * it is holding the file that needs the fix. Nothing here throws: a bad map is an
 * ordinary thing for a person to hand us, not an exception.
 *
 * The board comes back loosely typed on purpose. Its shape is data read from a
 * file, checked here once and then treated as a board by everything downstream;
 * a hand-written interface for it would be a second definition of the same thing
 * that this function is already the authority on.
 *
 * `errors` stop the board loading; `warnings` are things worth telling the author
 * about a board that loaded anyway — a named picture that does not exist, say.
 * Keeping them apart is what lets one misspelt drawing be a note rather than a
 * rejected board.
 *
 * @param {unknown} raw JSON text, or the parsed object
 * @returns {{ ok: boolean, map: any, errors: string[], warnings: string[] }}
 */
export function normaliseMap(raw) {
  const errors = [];
  const warnings = [];
  const fail = (message) => {
    errors.push(message);
    return { ok: false, map: null, errors, warnings };
  };

  let data = raw;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (err) {
      return fail(`Tệp không phải JSON hợp lệ: ${err instanceof Error ? err.message : "lỗi đọc"}.`);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return fail("Bản đồ phải là một đối tượng JSON.");
  }

  const src = data;
  const name = text(src.name, MAX_NAME);
  if (!name) return fail('Thiếu "name" — bản đồ cần một cái tên.');

  const money = { ...DEFAULT_MONEY };
  if (src.money && typeof src.money === "object") {
    const m = src.money;
    money.unit = text(m.unit, 6, DEFAULT_MONEY.unit);
    for (const key of ["start", "go", "bail"]) {
      if (m[key] === undefined) continue;
      const n = Math.round(Number(m[key]));
      if (!Number.isFinite(n) || n < 0 || n > 10_000_000) {
        errors.push(`"money.${key}" phải là số từ 0 đến 10.000.000.`);
      } else money[key] = n;
    }
  }

  const slug = name.toLocaleLowerCase("vi").normalize("NFD")
    .replace(MARKS_RE, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const meta = {
    id: text(src.id, 40) || `custom-${slug || "map"}`.slice(0, 48),
    name,
    icon: text(src.icon, MAX_ICON, "🗺️"),
    region: text(src.region, MAX_NAME),
    note: text(src.note, MAX_NOTE),
    scene: readScene(src.scene, "scene", warnings),
    money,
  };

  const cards = readCards(src, errors);

  // The explicit form wins when it is there, because somebody who wrote out 40
  // squares meant to.
  if (Array.isArray(src.spaces)) {
    const map = readExplicit(src, meta, cards, errors, warnings);
    if (!map) return { ok: false, map: null, errors, warnings };
    return { ok: errors.length === 0, map, errors, warnings };
  }

  const places = readNamed(src.places, 22, "places", errors, warnings, "📍");
  const transport = readNamed(src.transport, 4, "transport", errors, warnings, "🚉");
  const utilities = readNamed(src.utilities, 2, "utilities", errors, warnings, "⚡");
  const groups = readGroups(src.groups, errors);
  if (errors.length) return { ok: false, map: null, errors, warnings };

  const map = buildBoard({ ...meta, places, transport, utilities, groups, ...cards });
  return { ok: true, map, errors, warnings };
}

function readNamed(value, count, field, errors, warnings, fallbackIcon) {
  if (!Array.isArray(value)) {
    errors.push(`Thiếu "${field}" — cần một danh sách ${count} mục.`);
    return null;
  }
  if (value.length !== count) {
    errors.push(`"${field}" phải có đúng ${count} mục, tệp này có ${value.length}.`);
    return null;
  }
  const out = [];
  const seen = new Set();
  value.forEach((entry, i) => {
    // A bare string is allowed, because "just the names, in order" is how most
    // people will write their first map.
    const obj = typeof entry === "string" ? { name: entry } : entry;
    if (!obj || typeof obj !== "object") {
      errors.push(`"${field}[${i}]" phải là tên hoặc một đối tượng có "name".`);
      return;
    }
    const name = text(obj.name, MAX_NAME);
    if (!name) {
      errors.push(`"${field}[${i}]" thiếu tên.`);
      return;
    }
    const key = name.toLocaleLowerCase("vi");
    if (seen.has(key)) errors.push(`"${field}" có tên trùng: ${name}.`);
    seen.add(key);
    out.push({
      name,
      icon: text(obj.icon, MAX_ICON, fallbackIcon),
      note: text(obj.note, MAX_NOTE),
      scene: readScene(obj.scene, `${field}[${i}]`, warnings),
    });
  });
  return out;
}

/**
 * A named picture, or nothing.
 *
 * A misspelt scene is a complaint rather than a failure: the board still plays,
 * the square still gets a picture from the rotation, and the author gets told
 * which name they got wrong. Refusing to load a whole board over the spelling of
 * a drawing would be the wrong trade.
 */
function readScene(value, where, warnings) {
  if (value === undefined || value === null || value === "") return "";
  const key = text(value, 32);
  if (Object.hasOwn(SCENES, key)) return key;
  warnings.push(`"${where}.scene": không có hình nào tên “${key}” — dùng hình mặc định.`);
  return "";
}

function readGroups(value, errors) {
  if (!Array.isArray(value)) {
    errors.push('Thiếu "groups" — cần 8 nhóm màu.');
    return null;
  }
  if (value.length !== GROUP_SIZES.length) {
    errors.push(`"groups" phải có đúng ${GROUP_SIZES.length} nhóm, tệp này có ${value.length}.`);
    return null;
  }
  return value.map((entry, i) => {
    const obj = typeof entry === "string" ? { name: entry } : (entry ?? {});
    return {
      id: text(obj.id, 24) || `g${i}`,
      name: text(obj.name, MAX_NAME) || `Nhóm ${i + 1}`,
      icon: text(obj.icon, MAX_ICON),
      color: readColor(obj.color) ?? DEFAULT_GROUP_COLORS[i],
    };
  });
}

/** Only `#rgb`/`#rrggbb`. A map file has no business handing us a CSS expression. */
function readColor(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex) ? hex : null;
}

function readCards(src, errors) {
  const out = {};
  for (const [field, fallback] of [["chance", CHANCE_CARDS], ["chest", CHEST_CARDS]]) {
    if (src[field] === undefined) continue;
    if (!Array.isArray(src[field]) || src[field].length === 0) {
      errors.push(`"${field}" phải là danh sách lá thẻ, hoặc bỏ hẳn để dùng bộ mặc định.`);
      continue;
    }
    // The rest of a map file is fixed at 40 squares and 8 groups; the decks are
    // the one part with no natural length, and a deck nobody could get through in
    // a game is a mistake rather than a variant.
    if (src[field].length > MAX_CARDS) {
      errors.push(`"${field}" nhiều nhất ${MAX_CARDS} lá, tệp này có ${src[field].length}.`);
      continue;
    }
    const cards = [];
    src[field].forEach((entry, i) => {
      const card = readCard(entry, `${field}[${i}]`, errors);
      if (card) cards.push(card);
    });
    out[field] = cards.length ? cards : fallback;
  }
  return out;
}

const CARD_EFFECTS = new Set([
  "cash",
  "each",
  "toGo",
  "toRank",
  "back",
  "jail",
  "freeJail",
  "nearest",
  "repairs",
  "nudge",
  "jackpot",
  "shield",
  "freeBuild",
  "sellBuilding",
  "giveDeed",
  "swapDeed",
]);

const TIER_IDS = new Set(CHEST_TIERS.map((t) => t.id));

function readCard(entry, where, errors) {
  if (!entry || typeof entry !== "object") {
    errors.push(`"${where}" phải là một đối tượng.`);
    return null;
  }
  const body = text(entry.text, 140);
  const effect = entry.effect;
  if (!body) {
    errors.push(`"${where}" thiếu "text".`);
    return null;
  }
  if (!effect || typeof effect !== "object" || !CARD_EFFECTS.has(effect.k)) {
    errors.push(`"${where}.effect.k" phải là một trong: ${[...CARD_EFFECTS].join(", ")}.`);
    return null;
  }
  // Clamped rather than rejected: a card that pays a million is a typo, and
  // pulling it back to the edge of sane keeps the rest of the deck playable.
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
  const out = {
    icon: text(entry.icon, MAX_ICON, "🎴"),
    text: body,
    tier: TIER_IDS.has(entry.tier) ? entry.tier : DEFAULT_TIER,
    effect: { k: effect.k },
  };
  switch (effect.k) {
    case "cash":
    case "each":
      out.effect.amount = clamp(effect.amount, -2000, 2000);
      break;
    case "toRank":
      out.effect.rank = clamp(effect.rank, 0, PLACE_LADDER.length - 1);
      break;
    case "back":
      out.effect.steps = clamp(effect.steps, 1, 10);
      break;
    case "nearest":
      out.effect.target = effect.target === "utility" ? "utility" : "transport";
      out.effect.factor = clamp(effect.factor, 1, 10);
      break;
    case "repairs":
      out.effect.house = clamp(effect.house, 0, 500);
      out.effect.hotel = clamp(effect.hotel, 0, 1000);
      break;
    case "nudge":
      out.effect.steps = clamp(effect.steps, 1, 10);
      break;
    case "jackpot":
      out.effect.amount = clamp(effect.amount, 0, 2000);
      break;
  }
  return out;
}

/** The 40-square form, for a map that really does want a different layout. */
function readExplicit(src, meta, cards, errors, warnings) {
  const list = src.spaces;
  if (list.length !== BOARD_SIZE) {
    errors.push(`"spaces" phải có đúng ${BOARD_SIZE} ô, tệp này có ${list.length}.`);
    return null;
  }
  const groups = readGroups(src.groups, errors);
  if (!groups) return null;
  const groupIds = new Set(groups.map((g) => g.id));

  const num = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };

  const spaces = list.map((entry, i) => {
    const obj = (entry && typeof entry === "object") ? entry : {};
    const base = {
      name: text(obj.name, MAX_NAME) || `Ô ${i}`,
      icon: text(obj.icon, MAX_ICON, "📍"),
      note: text(obj.note, MAX_NOTE),
      scene: readScene(obj.scene, `spaces[${i}]`, warnings),
    };
    switch (obj.kind) {
      case "place": {
        if (!groupIds.has(obj.group)) {
          errors.push(`"spaces[${i}].group" không có trong "groups".`);
        }
        const rent = Array.isArray(obj.rent) && obj.rent.length === 6
          ? obj.rent.map((r) => num(r, 0, 20_000, 0))
          : null;
        if (!rent) errors.push(`"spaces[${i}].rent" phải là 6 số: trần, 1–4 nhà, khách sạn.`);
        return {
          kind: "place",
          ...base,
          group: obj.group,
          price: num(obj.price, 1, 10_000, 100),
          rent: rent ?? [0, 0, 0, 0, 0, 0],
          house: num(obj.house, 1, 5000, 100),
        };
      }
      case "transport":
        return { kind: "transport", ...base, price: num(obj.price, 1, 10_000, TRANSPORT_PRICE) };
      case "utility":
        return { kind: "utility", ...base, price: num(obj.price, 1, 10_000, UTILITY_PRICE) };
      case "tax":
        return {
          kind: "tax",
          ...base,
          amount: num(obj.amount, 0, 10_000, LUXURY_TAX),
          percent: obj.percent === undefined ? undefined : num(obj.percent, 0, 100, 10),
        };
      case "go":
      case "jail":
      case "parking":
      case "gotojail":
      case "chance":
      case "chest":
        return { kind: obj.kind, ...base };
      default:
        errors.push(`"spaces[${i}].kind" không hợp lệ: ${String(obj.kind)}.`);
        return { kind: "parking", ...base };
    }
  });

  // Structural minimums. A board with no Xuất phát, or two of them, is not a
  // variant but unplayable, and mid-game is the worst place to find that out.
  const count = (kind) => spaces.filter((s) => s.kind === kind).length;
  if (count("go") !== 1) errors.push('Bàn cần đúng một ô "go".');
  if (count("jail") !== 1) errors.push('Bàn cần đúng một ô "jail".');
  if (count("gotojail") !== 1) errors.push('Bàn cần đúng một ô "gotojail".');
  if (count("place") < 8) errors.push('Bàn cần ít nhất 8 ô "place" để chơi được.');
  if (errors.length) return null;

  // Pictures for whatever did not name one. Counted per kind so the rotation
  // walks through the scenes rather than restarting at every square.
  const nth = {};
  for (const space of spaces) {
    if (space.scene) continue;
    nth[space.kind] = (nth[space.kind] ?? 0) + 1;
    space.scene = sceneFor(space.kind, null, nth[space.kind] - 1);
  }

  // The middle of the board. An explicit board may price its own squares, so the
  // fallback emblem is whichever square it made the dearest.
  const dearest = spaces.reduce((best, s) => (s.price ?? 0) > (best?.price ?? 0) ? s : best, null);

  return {
    schema: MAP_SCHEMA,
    ...meta,
    scene: emblemFor(meta.scene, dearest?.scene),
    groups,
    spaces,
    chance: cards.chance ?? CHANCE_CARDS,
    chest: cards.chest ?? CHEST_CARDS,
  };
}

// ---------------------------------------------------------------------------
// Reading a board
// ---------------------------------------------------------------------------

/** "1.500K" — Vietnamese grouping, unit after the number. */
export function formatMoney(amount, unit = DEFAULT_MONEY.unit) {
  const n = Math.round(Number(amount) || 0);
  const sign = n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toLocaleString("vi-VN")}${unit}`;
}

/** True for squares somebody can own. */
export function isOwnable(space) {
  return space.kind === "place" || space.kind === "transport" || space.kind === "utility";
}

/** Board indices in one colour group, in board order. */
export function groupMembers(map, groupId) {
  const out = [];
  map.spaces.forEach((s, i) => {
    if (s.kind === "place" && s.group === groupId) out.push(i);
  });
  return out;
}

/** Buyable places sorted dearest first — what a card's `rank` indexes into. */
export function placesByRank(map) {
  return map.spaces
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === "place")
    .sort((a, b) => (b.s.price - a.s.price) || (a.i - b.i))
    .map(({ i }) => i);
}

/** Where the next square of `kind` is, walking forward from `from`. */
export function nearestOfKind(map, from, kind) {
  for (let step = 1; step <= map.spaces.length; step++) {
    const i = (from + step) % map.spaces.length;
    if (map.spaces[i].kind === kind) return i;
  }
  return from;
}

export function goSlot(map) {
  const i = map.spaces.findIndex((s) => s.kind === "go");
  return i < 0 ? 0 : i;
}

export function jailSlot(map) {
  const i = map.spaces.findIndex((s) => s.kind === "jail");
  return i < 0 ? 0 : i;
}
