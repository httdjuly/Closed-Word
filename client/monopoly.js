// The board game's screens: the chooser, the Vietnamese setup page, and the
// board itself.
//
// Everything visible here is in Vietnamese, and every label carries an icon,
// because that is what was asked for and because a board game is read at a
// glance — you want to know what a square is from across the table, not after
// reading it.
//
// This file draws and nothing more. It never works out rent, never decides whose
// turn it is and never moves a piece: the server sends what each square costs to
// land on and what the game is waiting for, and the buttons below are enabled or
// disabled from that. Where a check is duplicated here it is only so a button can
// look unavailable — the server refuses it either way, and its refusal is the one
// that counts.

import { $, append, el, fill } from "./dom.js";
import { blip, motionWanted, noise } from "./audio.js";
import {
  boardFailed,
  boardHost,
  ensureBoard,
  onFail as on3dFail,
  onPick as on3dPick,
  repaintBoard,
  webglOk,
} from "./mono3d.js";
import { onPrefsChange } from "./theme.js";
import {
  AUTO_END_MS,
  AUTO_IDLE_MS,
  CHEST_TIERS,
  DEFAULT_MONEY,
  formatMoney,
  JAIL_TURNS,
  MAX_HOUSES,
  ringPosition,
  TRANSPORT_RENT,
  UTILITY_MULTIPLIER,
} from "/shared/monopoly.js";
import { dieSvg, sceneSvg } from "/shared/monopoly_art.js";
import { GAME_KEYS, GAMES, LIMITS } from "/shared/constants.js";
import {
  feedColumn,
  hueFor,
  playersColumn,
  roomTopbar,
  setHueOverrides,
  updateDialogs,
  updateFeed,
  updateStandings,
  updateTopbar,
} from "./views.js";

/**
 * Every string on screen, in one place.
 *
 * Kept as a table rather than scattered through the markup so the Vietnamese can
 * be read and corrected as prose by somebody who is not reading JavaScript, and
 * so an icon and its words are chosen together — the pairing is the design, not
 * decoration bolted on afterwards.
 */
const VI = {
  brand: "Cờ tỷ phú",
  brandTail: "Việt Nam",
  yourName: "Tên của bạn",
  namePlaceholder: "ví dụ: Đức",
  newTable: "Mở bàn mới",
  joinTable: "Vào bàn có sẵn",
  code: "Mã bàn",
  join: "Vào bàn",
  create: "Mở bàn",
  pickMap: "Chọn bản đồ",
  houseRules: "Luật nhà",
  loadMap: "Tự làm bản đồ riêng",
  loadMapHint: "Không bắt buộc — bốn bản đồ trên đã chơi được ngay",
  players: "Người chơi",
  feed: "Diễn biến",
  chat: "Trò chuyện",
  chatPlaceholder: "nói gì đó, hoặc @ ai đó…",
  here: "Bạn đang ở",
  theirTurnHere: "Đang đi",
  nextUp: "Kế tiếp",
  afterTurns: (n) => `Bạn đi sau ${n} lượt`,
  autoLabel: "Tự động chơi hộ tôi",
  autoNote: "Bật khi bạn đang bận — bàn khỏi phải chờ",
  autoOn: "Máy đang chơi hộ bạn",
  autoIn: "Tự động sau",
  stillHere: "Tôi vẫn ở đây",
  watching: "Bạn đang xem trận này",
  watchingNote: "Đề nghị chơi lại thì trận sau bạn được chia bàn.",
  askRestart: "Đề nghị chơi lại từ đầu",
  restartTitle: "Chơi lại từ đầu?",
  agree: "Đồng ý",
  disagree: "Chơi tiếp",
  waitingVote: "Đang chờ",
  buildNow: "Xây ngay",
  buildLater: "Để sau",
  unlockedBuild: "Đã mở khoá xây",
  wholeGroup: "Đủ cả nhóm",
  start: "Bắt đầu",
  waiting: "Đang chờ chủ bàn bắt đầu",
  needTwo: `Cần ít nhất ${LIMITS.minBoardPlayers} người mới chơi được`,
  seats: "chỗ",
  turnOf: "Lượt của",
  yourTurn: "Lượt của bạn",
  cash: "Tiền mặt",
  worth: "Tổng tài sản",
  dice: "Xúc xắc",
  rolling: "Đang tung xúc xắc…",
  round: "Vòng",
  pot: "Giữa bàn",
  roll: "Tung xúc xắc",
  rollAgain: "Tung tiếp (được đôi)",
  buy: "Mua",
  skip: "Bỏ qua",
  toAuction: "Bỏ qua và đấu giá",
  payFlat: "Trả gọn",
  payPercent: "Trả theo phần trăm",
  payBail: "Nộp tiền bảo lãnh",
  useCard: "Dùng thẻ ra tù",
  rollForDouble: "Tung để tìm đôi",
  endTurn: "Kết thúc lượt",
  bankrupt: "Tuyên bố phá sản",
  skipTurn: "Bỏ lượt người mất kết nối",
  callTime: "Kết thúc trận, tính theo tài sản",
  playAgain: "Về bàn chờ",
  myEstate: "Tài sản của tôi",
  nothingOwned: "Bạn chưa có ô nào.",
  build: "Xây",
  sell: "Bán",
  mortgage: "Thế chấp",
  unmortgage: "Giải chấp",
  auction: "Đấu giá",
  highest: "Giá cao nhất",
  noBid: "Chưa có ai trả giá",
  bid: "Trả giá",
  withdraw: "Rút khỏi phiên",
  trade: "Đổi chác",
  tradeWith: "Đổi với",
  youGive: "Bạn đưa",
  youWant: "Bạn nhận",
  sendOffer: "Gửi đề nghị",
  incoming: "Đề nghị dành cho bạn",
  accept: "Đồng ý",
  decline: "Từ chối",
  cancelTrade: "Huỷ",
  owner: "Chủ",
  free: "Chưa ai mua",
  price: "Giá",
  rentNow: "Tiền thuê hiện tại",
  houseCost: "Giá mỗi nhà",
  mortgaged: "Đang thế chấp",
  houses: "nhà",
  hotel: "khách sạn",
  inJail: "Đang ở tù",
  jailCards: "thẻ ra tù",
  wentBankrupt: "Đã phá sản",
  won: "Người thắng",
  gameOver: "Trận đã kết thúc",
  downloadTemplate: "Tải mẫu bản đồ",
  chooseFile: "Chọn tệp JSON",
  orPaste: "hoặc dán nội dung JSON vào đây",
  applyMap: "Dùng bản đồ này",
  mapLoaded: "Đã tải bản đồ",
  mapProblems: "Bản đồ chưa dùng được",
  help: "Luật chơi — hướng dẫn",
  thisTable: "Bàn này",
  theRules: "Luật chơi đầy đủ",
  rulebookShort: "Luật",
  openRules: "Mở luật chơi đầy đủ",
  closeRules: "Đóng",
  onScreen: "Trên màn hình",
  ruleOn: "đang bật",
  ruleOff: "đang tắt",
  startCash: "Vốn ban đầu",
  salary: "Lương qua Xuất phát",
  bail: "Tiền ra tù",
  rules: {
    auction: { icon: "🔨", label: "Đấu giá khi có người bỏ qua", note: "Đúng luật in trên hộp" },
    parkingPot: {
      icon: "🅿️",
      label: "Tiền phạt dồn vào giữa bàn",
      note: "Ai vào ô đỗ xe thì vét sạch",
    },
    doubleGo: {
      icon: "🏁",
      label: "Dừng đúng ô Xuất phát nhận đôi lương",
      note: "Chỉ khi dừng đúng ô",
    },
  },
};

/** What kind of square this is, in one word and one glyph. */
const KIND_LABEL = {
  go: { icon: "🏁", label: "Xuất phát" },
  place: { icon: "📍", label: "Địa điểm" },
  transport: { icon: "🚉", label: "Giao thông" },
  utility: { icon: "⚡", label: "Tiện ích" },
  chance: { icon: "🎲", label: "Cơ hội" },
  chest: { icon: "🧧", label: "Khí vận" },
  tax: { icon: "🧾", label: "Thuế" },
  jail: { icon: "🚔", label: "Tạm giam" },
  parking: { icon: "🅿️", label: "Đỗ xe" },
  gotojail: { icon: "👮", label: "Vào tù" },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Re-render a region without stealing the caret.
 *
 * The bid box and the trade cash boxes live inside panels that are rebuilt from
 * every snapshot, and in an auction snapshots arrive while somebody is still
 * typing their bid. Restoring by id afterwards is enough because the rebuilt
 * input carries the same id and its value is written back from `local`.
 */
function preservingFocus(fn) {
  const active = document.activeElement;
  const id = active?.id;
  const caret = active?.selectionStart ?? null;
  fn();
  if (!id) return;
  const next = document.getElementById(id);
  if (!next || typeof next.focus !== "function") return;
  next.focus();
  if (caret !== null && typeof next.setSelectionRange === "function") {
    try {
      next.setSelectionRange(caret, caret);
    } catch {
      // Not a text input; having the focus back is the part that mattered.
    }
  }
}

function money(mono, amount) {
  return formatMoney(amount, mono?.map?.money?.unit ?? "K");
}

function nameOf(state, id) {
  return state.players.find((p) => p.id === id)?.nickname ?? "—";
}

function seatOf(mono, id) {
  return mono.players.find((p) => p.id === id);
}

/** The group a place belongs to, for its colour band. */
function groupOf(mono, space) {
  return mono.map.groups.find((g) => g.id === space.group);
}

/**
 * A player's piece on the flat board.
 *
 * It used to be the seat's emoji at text size, which answered "somebody is here"
 * and not "who". Two things fix that. It is now a disc big enough to see from
 * across a desk, and it carries the player's own colour — the same hue the feed
 * tints their name with and the players list puts beside it, so the colour is
 * something you have already learnt by the time it matters. Your own piece gets
 * a ring, because the first question anybody asks a board is where am I.
 */
function pieceNode(ctx, player, onTurn = false) {
  const mine = player.id === ctx.state.you.id;
  const classes = ["tok"];
  if (player.inJail) classes.push("jailed");
  if (mine) classes.push("mine");
  // The piece of whoever is up breathes. On a grid of forty squares it is the
  // cheapest possible answer to "where is the game right now".
  if (onTurn) classes.push("onturn");
  return el("span", {
    class: classes.join(" "),
    "data-pid": player.id,
    style: `--tok-hue:${hueFor(player.id)}`,
    title: `${nameOf(ctx.state, player.id)}${player.inJail ? " — trong tù" : ""}`,
    text: player.token,
  });
}

/** "🏠🏠" or "🏨", the way a board shows what has been built. */
function buildingGlyphs(level) {
  if (!level) return "";
  return level > 4 ? "🏨" : "🏠".repeat(level);
}

/**
 * A square's picture.
 *
 * Two sizes of the same drawing: `sq-art` sits behind the name on the board,
 * turned down so the words stay first; `detail-art` is the postcard across the
 * top of the deed card, where the picture is the point. Injected as markup
 * because the drawing *is* markup — see shared/monopoly_art.js for why it is not
 * a file on a server somewhere.
 */
function sceneNode(space, cls) {
  return el("span", { class: cls, "aria-hidden": "true", html: sceneSvg(space.scene) });
}

/**
 * The board's own picture, in the hole in the middle.
 *
 * Fitted rather than cropped — the middle is nearly square and there is room to
 * show all of it — and behind everything the middle is actually for: the card
 * that was just drawn, and the deed you clicked.
 */
function emblemNode(mono) {
  return el("span", {
    class: "board-art",
    "aria-hidden": "true",
    html: sceneSvg(mono.map.scene, "meet"),
  });
}

function levelLabel(level) {
  if (!level) return "";
  return level > 4 ? `1 ${VI.hotel}` : `${level} ${VI.houses}`;
}

// ---------------------------------------------------------------------------
// The chooser
//
// The first thing anybody sees. Two games share this server and share nothing
// else on screen, so picking one is a screen of its own rather than a dropdown
// buried in a form — and the choice is remembered, so it is the first screen
// once and not every time.
// ---------------------------------------------------------------------------

export function buildGameGate(ctx) {
  const { actions } = ctx;
  const root = el("div", { class: "landing gate" });

  append(root, [
    el("div", { class: "hero" }, [
      el("div", { class: "eyebrow", text: "Two games, one room code" }),
      el("h1", { html: "Pick a game. <em>Chọn một trò.</em>" }),
      el("p", {
        class: "lede",
        text: "Both run on this server and both hold a whole team. " +
          "Cả hai đều chạy trên máy này và chơi được cả nhóm.",
      }),
    ]),
    el(
      "div",
      { class: "game-pick" },
      GAME_KEYS.map((key) => {
        const game = GAMES[key];
        return el("button", {
          type: "button",
          class: "game-card",
          lang: game.lang,
          onClick: () => actions.chooseGame(key),
        }, [
          el("span", { class: "game-icon", "aria-hidden": "true", text: game.icon }),
          el("strong", { text: game.label }),
          el("span", { class: "game-tag", text: game.tagline }),
          el("small", { text: game.blurb }),
          el("span", {
            class: "game-go",
            text: game.lang === "vi" ? "Vào cài đặt →" : "Set up a room →",
          }),
        ]);
      }),
    ),
  ]);
  return root;
}

// ---------------------------------------------------------------------------
// The Vietnamese setup page
// ---------------------------------------------------------------------------

export function buildMonoLanding(ctx) {
  const { local, actions } = ctx;
  const root = el("div", { class: "landing", lang: "vi" });

  const nickField = el("div", { class: "field" }, [
    el("label", { for: "nick", text: `🙋 ${VI.yourName}` }),
    el("input", {
      id: "nick",
      type: "text",
      maxlength: LIMITS.maxNicknameLength,
      placeholder: VI.namePlaceholder,
      value: local.nickname,
      autocomplete: "off",
      onInput: (e) => actions.setNickname(e.target.value),
    }),
  ]);

  const codeInput = el("input", {
    id: "roomCode",
    type: "text",
    class: "code-input",
    maxlength: LIMITS.roomCodeLength,
    placeholder: "ABC123",
    value: local.pendingCode ?? "",
    autocapitalize: "characters",
    spellcheck: "false",
    onInput: (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      local.pendingCode = e.target.value;
    },
    onKeydown: (e) => {
      if (e.key === "Enter") actions.join(local.pendingCode);
    },
  });

  const joinCard = el("form", {
    class: "card",
    onSubmit: (e) => {
      e.preventDefault();
      actions.join(local.pendingCode);
    },
  }, [
    el("h2", { text: `🚪 ${VI.joinTable}` }),
    el("div", { class: "field" }, [
      el("label", { for: "roomCode", text: `🔢 ${VI.code}` }),
      codeInput,
    ]),
    el("button", { class: "primary", type: "submit", style: "width:100%", text: VI.join }),
  ]);

  // The board picker. Filled by `updateMonoLanding` from /api/info, because the
  // list of boards this server can offer is the server's to state.
  const mapPick = el("div", { class: "mode-pick", id: "monoMapPick" });

  const rulesField = el(
    "div",
    { class: "rule-list" },
    Object.entries(VI.rules).map(([key, info]) =>
      ruleToggle(info, local.newConfig[configKeyFor(key)], (on) => {
        local.newConfig[configKeyFor(key)] = on;
      })
    ),
  );

  const createCard = el("form", {
    class: "card",
    onSubmit: (e) => {
      e.preventDefault();
      actions.create(local.newConfig);
    },
  }, [
    el("h2", { text: `🎲 ${VI.newTable}` }),
    el("div", { class: "field" }, [
      el("label", { text: `🗺️ ${VI.pickMap}` }),
      mapPick,
      el("small", {
        class: "muted tiny-text",
        text: "Bàn 40 ô là đường phố và địa danh của nơi đó. " +
          "Chủ bàn có thể tải bản đồ riêng sau khi mở bàn.",
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { text: `📜 ${VI.houseRules}` }),
      rulesField,
    ]),
    el("div", { class: "field" }, [
      el("label", { text: "👥 Mời người vào bàn" }),
      el("button", {
        type: "button",
        style: "width:100%",
        text: "Mời người đang mở ứng dụng",
        onClick: () => actions.openInvitePicker(),
      }),
      el("small", {
        class: "muted tiny-text",
        text: `Bàn cờ ngồi tối đa ${LIMITS.maxBoardPlayers} người.`,
      }),
    ]),
    el("button", {
      class: "primary",
      type: "submit",
      style: "width:100%",
      text: `🎲 ${VI.create}`,
    }),
  ]);

  append(root, [
    el("div", { class: "hero" }, [
      el("div", { class: "eyebrow" }, [
        el("button", {
          type: "button",
          class: "ghost tiny",
          text: "← Đổi trò",
          onClick: () => actions.chooseGame(null),
        }),
      ]),
      el("h1", { html: "Cờ tỷ phú <em>Việt Nam</em>" }),
      el("p", { class: "lede", text: GAMES.monopoly.blurb }),
    ]),
    el("div", { class: "landing-grid" }, [
      el("div", { class: "stack" }, [createCard]),
      el("div", { class: "stack" }, [
        el("div", { class: "card" }, [nickField]),
        joinCard,
        el("div", { class: "card" }, [
          el("h2", { text: "📖 Luật rút gọn" }),
          rulesSummary(),
        ]),
      ]),
    ]),
    el("div", { id: "dialogLayer" }),
  ]);
  return root;
}

/** `monoAuction` from `auction`, so the table above can be keyed by plain names. */
function configKeyFor(key) {
  return `mono${key[0].toUpperCase()}${key.slice(1)}`;
}

function ruleToggle(info, checked, onChange) {
  const box = el("input", {
    type: "checkbox",
    checked: Boolean(checked),
    onChange: (e) => onChange(e.target.checked),
  });
  return el("label", { class: "rule-row" }, [
    box,
    el("span", { class: "rule-icon", "aria-hidden": "true", text: info.icon }),
    el("span", {}, [
      el("strong", { text: info.label }),
      el("small", { class: "muted", text: info.note }),
    ]),
  ]);
}

function rulesSummary() {
  const lines = [
    ["🎲", "Tung hai xúc xắc, được đôi thì tung tiếp. Ba lần đôi liên tiếp thì vào tù."],
    ["🏁", "Qua ô Xuất phát thì nhận lương."],
    ["🏷️", "Ô chưa có chủ: mua theo giá niêm yết, hoặc bỏ qua để đưa ra đấu giá."],
    ["💰", "Đủ cả nhóm màu thì tiền thuê nhân đôi. Xây nhà thì tăng theo bậc."],
    ["🏗️", "Phải xây đều trong nhóm: tối đa 4 nhà rồi mới lên khách sạn."],
    ["📄", "Thế chấp lấy nửa giá; ô đang thế chấp không thu tiền thuê. Giải chấp mất thêm 10%."],
    ["🃏", "Ô Cơ hội và Khí vận: rút một lá và làm theo lá đó."],
    ["🧾", "Ô thuế: trả mức ghi trên ô — thuế thu nhập cho chọn tiền mặt hoặc 10% tài sản."],
    ["🚔", "Trong tù: nộp tiền, dùng thẻ, hoặc tung đôi. Sau ba lượt thì buộc phải nộp."],
    ["🤝", "Đổi chác tự do, nhưng phải bán hết công trình trước khi chuyển nhượng."],
    ["🏳️", "Hết khả năng trả nợ thì phá sản. Còn một người thì người đó thắng."],
  ];
  return el(
    "div",
    { class: "rule-brief" },
    lines.map(([icon, text]) =>
      el("div", { class: "rule-brief-row" }, [
        el("span", { "aria-hidden": "true", text: icon }),
        el("span", { text }),
      ])
    ),
  );
}

/**
 * The rules in full, for reading at the table rather than before it.
 *
 * The landing page's `rulesSummary` is a poster: eleven lines somebody skims
 * while deciding whether to join. This is the rulebook, and it exists because
 * the questions that actually get asked arrive mid-game — how much does a
 * second house pay, what does unmortgaging cost, can I build while I am in jail
 * — and the answer has to be findable without leaving the board or asking the
 * one person at the table who has played before.
 *
 * The numbers come from this table's map, not from the printed defaults, so a
 * board with its own salary or its own bail reads correctly instead of
 * confidently telling somebody the wrong figure.
 */
function rulesFull(mono) {
  const m = mono.map.money;
  const cash = (n) => money(mono, n);
  const salary = mono.rules.doubleGo
    ? `Mỗi lần đi qua ô Xuất phát nhận ${cash(m.go)} — và bàn này bật luật dừng ` +
      `đúng ô thì nhận đôi, tức ${cash(m.go * 2)}.`
    : `Mỗi lần đi qua hoặc dừng ở ô Xuất phát nhận ${cash(m.go)}.`;
  const takeIt = mono.rules.auction
    ? `Bỏ qua thì ô ra đấu giá ngay tại chỗ: mọi người còn trong bàn đều được trả ` +
      `giá, kể cả người vừa bỏ qua. Ai rút thì mất quyền, người trả cao nhất còn ` +
      `lại mua ô đúng bằng số mình đã trả — có thể rẻ hơn hẳn giá niêm yết.`
    : `Bàn này tắt đấu giá: bỏ qua thì ô nằm lại với ngân hàng cho tới khi có ` +
      `người khác dừng vào.`;
  const stations = TRANSPORT_RENT.map((r) => cash(r)).join(" / ");

  const sections = [
    ["🎯", "Mục tiêu", [
      `Ai cũng bắt đầu với ${cash(m.start)}. Đi vòng quanh bàn, mua ô, rồi sống ` +
      `bằng tiền thuê của người khác.`,
      "Hết khả năng trả nợ thì phá sản và rời bàn. Còn lại một người thì người đó thắng.",
    ]],
    ["🎲", "Một lượt đi", [
      "Tung hai xúc xắc và đi đúng tổng số nút, theo chiều mũi tên quanh bàn.",
      "Đến nơi thì làm việc của ô đó — mua, trả tiền thuê, rút thẻ, nộp thuế — " +
      "rồi bấm Kết thúc lượt.",
      "Ra đôi thì xong ô là được tung tiếp. Ba lần đôi liên tiếp trong một lượt " +
      "thì lần thứ ba đi thẳng vào tù, không đi tiếp và không nhận lương.",
      "Xây, thế chấp và đổi chác làm được bất cứ lúc nào — kể cả khi chưa tới " +
      "lượt mình hay đang ngồi trong tù. Chỉ dừng lại khi đang có phiên đấu giá " +
      "hoặc đang chờ ai đó trả nợ.",
    ]],
    ["🏁", "Xuất phát", [salary]],
    ["🏷️", "Mua ô", [
      "Dừng vào ô chưa có chủ thì được mua đúng giá in trên ô. Không mặc cả, " +
      "và chỉ người dừng vào mới được mua.",
      takeIt,
    ]],
    ["💰", "Tiền thuê", [
      "Dừng vào ô của người khác là tự động trả tiền thuê — không phải đòi, và " +
      "chủ ô không cần đang online.",
      `Mỗi ô địa điểm có sáu mức thuê: chưa xây, 1 nhà, 2 nhà, 3 nhà, 4 nhà và ` +
      `khách sạn. Bấm vào ô để xem cả bảng.`,
      "Giữ đủ cả nhóm màu mà chưa xây gì thì mức thuê trần nhân đôi. Đó là lý do " +
      "gom cho đủ nhóm đáng giá ngay cả khi chưa có tiền xây.",
      "Ô đang thế chấp thì không thu được đồng nào.",
    ]],
    ["🏗️", "Xây nhà theo mốc", [
      "Giữ đủ cả nhóm màu (và trong nhóm không còn ô nào đang thế chấp) thì xây " +
      "lúc nào cũng được — bấm 🏗️ trong khung “Tài sản của tôi”.",
      "Chưa đủ nhóm màu thì vẫn xây được, nhưng chỉ đúng lúc bạn dừng vào ô đó: " +
      "mỗi lần về nhà mình, bàn sẽ hỏi “xây thêm hay để sau?”. Trả lời rồi là " +
      "xong — đi khỏi ô thì phải chờ lần ghé sau. Luật in trên hộp bắt phải đủ cả " +
      "nhóm, mà một bàn bốn người thường chẳng ai đủ nhóm bao giờ, nên nửa sau " +
      "của trò chơi sẽ không bao giờ xảy ra.",
      "Đang đứng trên ô mà còn tiền thì hỏi tiếp: xây được mấy mốc trong một lần " +
      "ghé cũng được.",
      `Mỗi lần xây là lên một mốc: 1 → 2 → 3 → ${MAX_HOUSES} nhà, mốc cuối là ` +
      `khách sạn. Giá mỗi lần xây ghi trên ô và giống nhau ở mọi mốc.`,
      "Tiền thuê nhảy theo mốc chứ không cộng dồn: đang ở mốc 2 nhà thì thu đúng " +
      "mức “2 nhà” trong bảng, thường gấp ba mức 1 nhà.",
      "Phải xây đều: không ô nào được vượt ô thấp nhất trong nhóm quá một mốc. " +
      "Muốn có ô 2 nhà thì cả nhóm phải có 1 nhà trước.",
      "Bán lại cho ngân hàng được nửa giá xây, và cũng phải bán đều — bán ô cao " +
      "nhất trong nhóm trước.",
    ]],
    ["🚉", "Giao thông và tiện ích", [
      `Ô giao thông: thuê ${stations} tuỳ chủ ô đang giữ 1, 2, 3 hay cả ` +
      `${TRANSPORT_RENT.length} ô.`,
      `Ô tiện ích: thuê bằng tổng hai xúc xắc nhân ${UTILITY_MULTIPLIER[0]} nếu ` +
      `chủ giữ một ô, nhân ${UTILITY_MULTIPLIER[1]} nếu giữ cả hai.`,
      "Hai loại này không xây nhà được, nhưng vẫn thế chấp và đổi chác bình thường.",
    ]],
    ["📄", "Thế chấp", [
      "Thế chấp một ô thì nhận về nửa giá mua. Ô vẫn là của bạn, nhưng ngừng thu " +
      "tiền thuê cho tới khi giải chấp.",
      "Muốn thế chấp ô địa điểm thì phải bán hết nhà trong cả nhóm trước.",
      "Giải chấp trả lại đúng số đã nhận cộng thêm 10% lãi.",
    ]],
    ["🧾", "Thuế, Cơ hội và Khí vận", [
      "Ô thuế thu mức ghi trên ô. Riêng thuế thu nhập cho chọn: trả khoản cố định " +
      "hoặc 10% tổng tài sản — bên nào lợi hơn là tuỳ lúc.",
      "Tổng tài sản tính bằng tiền mặt cộng giá mua các ô đang giữ (ô thế chấp " +
      "tính nửa) cộng tiền đã bỏ ra xây.",
      "Ô Cơ hội: bộ thẻ in trên hộp, xáo một lần rồi rút lần lượt — mỗi vòng đủ " +
      "cả bộ. Có lá cho tiền, có lá bắt trả, có lá bắt đi tới ô khác, và có thẻ " +
      "ra tù để dành.",
      "Ô Khí vận: không phải bộ thẻ mà là một lượt quay số. Mỗi lần rút, hệ thống " +
      "bốc hạng trước — " +
      CHEST_TIERS.map((t) => `${t.icon} ${t.name}`).join(", ") +
      " — rồi mới bốc một lá trong hạng đó, nên lá xịn vẫn hiếm và cùng một lá có " +
      "thể ra hai lần.",
      "Hạng thấp là tiền lẻ. Hạng cao thì động tới bất động sản: buộc phá một " +
      "công trình, trao ô rẻ nhất của bạn cho người ít tài sản nhất bàn, đổi ô " +
      "với người giàu nhất, vét hũ giữa bàn, xây miễn phí một mốc, hoặc 🛡️ được " +
      "miễn tiền thuê một lần.",
      "Những lá đó do bàn tự chọn ô — ô rẻ nhất, công trình cao nhất — chứ không " +
      "bắt bạn ngồi chọn, để cả bàn không phải chờ.",
    ]],
    ["🚔", "Nhà tù", [
      "Vào tù khi dừng vào ô Vào tù, khi ra đôi ba lần liên tiếp, hoặc khi rút " +
      "phải lá bắt đi tù. Đi thẳng, không qua Xuất phát, không nhận lương.",
      "Ngồi tù vẫn thu tiền thuê, vẫn xây, vẫn thế chấp và đổi chác được — chỉ là " +
      "không đi.",
      `Ra tù bằng một trong ba cách: nộp ${cash(m.bail)}, dùng thẻ ra tù, hoặc ` +
      `tung được đôi.`,
      `Sau ${JAIL_TURNS} lượt vẫn chưa ra thì ${cash(m.bail)} bị trừ thẳng và ` +
      `bạn đi tiếp theo số vừa tung.`,
    ]],
    ["🤝", "Đổi chác", [
      "Gửi lời đề nghị gồm tiền và ô cho bất kỳ ai; họ nhận hoặc từ chối. Không " +
      "cần đúng lượt của ai cả.",
      "Ô còn công trình thì không đổi được — bán hết nhà trong nhóm trước đã.",
      "Mỗi cặp người chỉ giữ một lời đề nghị đang mở, đề nghị mới thay đề nghị cũ.",
    ]],
    ["🏳️", "Hết tiền và phá sản", [
      "Nợ mà thiếu tiền mặt thì phải bán nhà và thế chấp ô để xoay đủ. Bàn dừng " +
      "lại chờ, kể cả khi đó không phải lượt của bạn.",
      "Bán và thế chấp hết mà vẫn không đủ thì tuyên bố phá sản.",
      "Nợ người khác thì toàn bộ tiền và ô sang tay người đó, nhà trong tay bạn " +
      "được ngân hàng mua lại nửa giá và trả cho họ. Nợ ngân hàng thì các ô về " +
      "lại ngân hàng, trống chủ như đầu ván.",
    ]],
  ];

  return el(
    "div",
    { class: "rule-full" },
    sections.map(([icon, title, lines]) =>
      el("section", {}, [
        el("h5", {}, [
          el("span", { "aria-hidden": "true", text: icon }),
          el("span", { text: title }),
        ]),
        ...lines.map((text) => el("p", { text })),
      ])
    ),
  );
}

export function updateMonoLanding(ctx) {
  const { local } = ctx;
  const pick = $("monoMapPick");
  if (!pick) return;
  const maps = local.serverInfo?.monoMaps ?? [];
  if (!maps.length) {
    fill(pick, el("div", { class: "muted tiny-text", text: "Đang tải danh sách bản đồ…" }));
    return;
  }
  if (!maps.some((m) => m.id === local.newConfig.monoMap)) {
    local.newConfig.monoMap = maps[0].id;
  }
  fill(
    pick,
    maps.map((m) =>
      el("button", {
        type: "button",
        "aria-pressed": String(local.newConfig.monoMap === m.id),
        onClick: () => {
          local.newConfig.monoMap = m.id;
          updateMonoLanding(ctx);
        },
      }, [
        el("strong", { text: `${m.icon} ${m.name}` }),
        el("small", { text: m.region ? `${m.region} — ${m.note}` : m.note }),
      ])
    ),
  );
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

export function buildMonoRoom(ctx) {
  // A fresh screen: whatever the dice say on the first snapshot is the state of
  // play, not a throw to re-enact at somebody who has just walked in.
  forgetDice();
  // A fresh room means a fresh, empty rules layer, whatever the last one held.
  bookMounted = false;
  const root = el("div", { style: "display:flex;flex-direction:column;flex:1", lang: "vi" });

  const topbar = roomTopbar(
    ctx,
    el("div", { class: "brand", html: `Cờ <span>tỷ phú</span> ${VI.brandTail}` }),
    {
      buzz: "⚡ Gọi",
      buzzTitle: "Gọi cả bàn chú ý",
      inviteTitle: "Mời người đang mở ứng dụng",
      themeTitle: "Đổi sáng / tối",
      news: "Có gì mới",
      leave: "Rời bàn",
    },
    el("button", {
      class: "ghost tiny",
      title: "Luật chơi và cách dùng màn hình",
      text: `📖 ${VI.rulebookShort}`,
      onClick: () => ctx.actions.openMonoRules(),
    }),
  );

  const centre = el("div", { class: "stage-col mono-col" }, [
    el("div", { class: "panel" }, [
      el("div", { class: "banner", id: "monoBanner" }),
      el("div", { id: "monoStage", class: "mono-stage" }),
    ]),
  ]);

  append(root, [
    topbar,
    el("div", { class: "room board" }, [
      // Your own deeds live in the left rail, directly under the table, rather
      // than below the board where they were: a panel you have to scroll past a
      // board to reach is a panel nobody uses, and "what do I own and can I build
      // on it" is the second thing you look at all game.
      el("div", { class: "rail-left" }, [
        playersColumn(VI.players),
        el("div", { id: "monoEstate" }),
      ]),
      centre,
      feedColumn(
        ctx,
        VI.feed,
        VI.chatPlaceholder,
        { send: "Gửi", emoji: "Biểu tượng", emojiAria: "Chèn biểu tượng cảm xúc" },
        // Two panels, not one list. A board game writes a hundred lines an hour
        // and a question somebody asked the table was getting buried three
        // screens up in dice rolls.
        { chatTitle: `💬 ${VI.chat}` },
      ),
    ]),
    el("div", { id: "journeyLayer" }),
    el("div", { id: "monoFx", class: "mono-fx", "aria-hidden": "true" }),
    el("div", { id: "monoRulesLayer" }),
    el("div", { id: "dialogLayer" }),
  ]);
  return root;
}

export function updateMonoRoom(ctx) {
  const { state } = ctx;
  if (!state) return;
  // Before anything draws a person. The board deals one hue per seat, and until
  // this is set the feed, the standings and the pieces are all colouring people
  // by a hash that puts two of three players in the same green.
  setHueOverrides(
    state.mono ? new Map(state.mono.players.map((p) => [p.id, p.hue])) : null,
  );
  clockSkew = (state.serverNow ?? Date.now()) - Date.now();
  updateTopbar(ctx);
  updateStandings(ctx);
  updateFeed(ctx);
  updateDialogs(ctx);
  updateRulebook(ctx);

  preservingFocus(() => {
    const banner = $("monoBanner");
    const stage = $("monoStage");
    const estate = $("monoEstate");
    if (!banner || !stage) return;
    if (state.phase === "lobby" || !state.mono) {
      fill(banner, lobbyBanner(ctx));
      fill(stage, lobbyStage(ctx));
      if (estate) fill(estate, null);
      stopClock();
      return;
    }
    // Before the banner is built, so it can render the dice mid-air.
    throwDice(ctx, state.mono);
    revealCard(ctx, state.mono);
    announceTurn(ctx, state.mono);
    fill(banner, gameBanner(ctx, state.mono));
    wire3d(ctx);
    // Top to bottom in the order somebody needs it: whose turn, what to press,
    // what is under the hammer, where you are standing, then the board, then
    // everything optional.
    fill(stage, [
      state.you.spectator ? watchingBanner(ctx, state.mono) : null,
      turnBar(ctx, state.mono),
      actionBar(ctx, state.mono),
      // Directly under the buttons rather than in the hole in the middle of the
      // board. An auction is a decision on a clock for everybody at once, and it
      // was the only thing on the table you had to go and find — worse on the 3D
      // board, where it was below the board entirely.
      state.mono.auction ? auctionPanel(ctx, state.mono) : null,
      restartPanel(ctx, state.mono),
      hereBar(ctx, state.mono),
      viewMode(ctx) === "3d" ? board3d(ctx, state.mono) : flatBoard(ctx, state.mono),
      el("div", { class: "mono-panels" }, [
        tradePanel(ctx, state.mono),
        helpPanel(ctx, state.mono),
      ]),
    ]);
    if (estate) fill(estate, estatePanel(ctx, state.mono));
    // After the board is in the page: the walk is measured off the squares.
    walkFlat(ctx, state.mono);
    armClock();
  });
}

// --- whose turn, and how long you have ------------------------------------

/**
 * Server clock minus browser clock, refreshed from every snapshot.
 *
 * The board's deadlines are server timestamps and the countdown runs in the
 * browser, so a laptop whose clock is four minutes out would otherwise show a
 * four-minute countdown or none at all.
 */
let clockSkew = 0;
let clockTimer = 0;

/**
 * Repaint every countdown on screen, four times a second.
 *
 * The seconds have to move without a snapshot — nothing is happening on the
 * board, which is exactly why there is a countdown — so they are written
 * straight into the text of whatever carries a `data-until`, and the elements
 * themselves are rebuilt with the rest of the page as usual.
 */
function paintClocks() {
  const nodes = document.querySelectorAll("[data-until]");
  if (!nodes.length) {
    stopClock();
    return;
  }
  for (const node of nodes) {
    const left = Number(node.dataset.until) - (Date.now() + clockSkew);
    node.textContent = left > 0 ? `${Math.ceil(left / 1000)}s` : "…";
    node.classList.toggle("urgent", left > 0 && left <= 6000);
  }
}

function armClock() {
  if (clockTimer) return;
  if (!document.querySelector("[data-until]")) return;
  paintClocks();
  clockTimer = setInterval(paintClocks, 250);
}

function stopClock() {
  if (!clockTimer) return;
  clearInterval(clockTimer);
  clockTimer = 0;
}

/** The turn we last announced, so the chime lands on the change and not on every snapshot. */
let announcedTurn = null;

/**
 * Two notes when your turn comes round.
 *
 * The board makes a dozen sounds and this is the only one you need to hear from
 * the kitchen, so it is the only one that is two notes rising. Silent on the
 * first snapshot: walking into a room where it is already your turn is not an
 * event, and it would fire on every reconnect.
 */
function announceTurn(ctx, mono) {
  if (mono.turnId === announcedTurn) return;
  const first = announcedTurn === null;
  announcedTurn = mono.turnId;
  if (first || mono.turnId !== ctx.state.you.id) return;
  blip({ freq: 620, dur: 0.12, gain: 0.15 });
  blip({ at: 0.14, freq: 930, dur: 0.2, gain: 0.15 });
}

/** What the board is actually waiting for, in the second person. */
function askOf(mono) {
  // An auction suspends the turn and leaves `pending` as it was, so reading it
  // here would tell somebody to buy a square that is on the block.
  if (mono.auction) {
    return `Đang đấu giá ${mono.spaces[mono.auction.space]?.name ?? ""} — ai cũng được trả giá`;
  }
  const p = mono.pending;
  switch (p.kind) {
    case "roll":
      return mono.doubles > 0 ? "Được đôi — tung tiếp" : "Tung xúc xắc";
    case "jail":
      return "Đang ở tù — nộp tiền, dùng thẻ, hoặc tung đôi";
    case "buy":
      return `Mua hay bỏ ${mono.spaces[p.space]?.name ?? "ô này"}`;
    case "upgrade":
      return `Về nhà mình — xây thêm ở ${mono.spaces[p.space]?.name ?? "ô này"}?`;
    case "tax":
      return "Chọn cách trả thuế";
    case "debt":
      return `Trả ${money(mono, p.amount)} — bán nhà hoặc thế chấp`;
    case "end":
      return "Xây, đổi chác, rồi kết thúc lượt";
    default:
      return "";
  }
}

/**
 * The strip that answers "is it me?" without being read.
 *
 * This was the thing most obviously missing from the running game: whose turn it
 * was lived in one small chip in a banner full of other chips. Now the whole
 * strip takes the colour of whoever is up, and when that is you it says so in
 * the largest type on the screen and breathes. Underneath, the queue — because
 * the moment you know it is not you, the next question is how long you have got.
 */
function turnBar(ctx, mono) {
  const { state } = ctx;
  const you = state.you.id;
  const seat = mono.turnId ? seatOf(mono, mono.turnId) : null;
  const yours = mono.turnId === you;
  const waiting = mono.waitingOn;
  const onYou = waiting === you;
  const seats = [...mono.players].sort((a, b) => a.order - b.order);
  const turnAt = seats.findIndex((p) => p.id === mono.turnId);

  // Turns until you are up, skipping anybody already out.
  let mine = null;
  if (!yours && turnAt >= 0 && seatOf(mono, you) && !seatOf(mono, you).bankrupt) {
    let turns = 0;
    for (let step = 1; step <= seats.length; step++) {
      const s = seats[(turnAt + step) % seats.length];
      if (s.bankrupt) continue;
      turns++;
      if (s.id === you) {
        mine = turns;
        break;
      }
    }
  }

  const queue = [];
  for (let step = 0; step < seats.length && queue.length < 5; step++) {
    const s = seats[((turnAt < 0 ? 0 : turnAt) + step) % seats.length];
    if (s.bankrupt) continue;
    queue.push(
      el("span", {
        class: `q-chip${step === 0 ? " now" : ""}${s.id === you ? " you" : ""}`,
        style: `--who-hue:${s.hue}`,
        title: `${nameOf(state, s.id)}${step === 0 ? " — đang đi" : ` — sau ${queue.length} lượt`}`,
      }, [
        el("span", { class: "q-tok", "aria-hidden": "true", text: s.token }),
        el("span", { class: "q-name", text: nameOf(state, s.id) }),
      ]),
    );
  }

  const bits = [];
  if (mono.winnerId) {
    bits.push(
      el("strong", { class: "turn-say", text: `🏆 ${VI.won}: ${nameOf(state, mono.winnerId)}` }),
    );
  } else {
    bits.push(
      el("div", { class: "turn-say" }, [
        el("span", { class: "turn-tok", "aria-hidden": "true", text: seat?.token ?? "🎲" }),
        el("div", { class: "turn-words" }, [
          el("strong", {
            text: yours ? "LƯỢT CỦA BẠN" : `${VI.turnOf} ${nameOf(state, mono.turnId)}`,
          }),
          el("small", {
            text: mono.auction || onYou
              ? askOf(mono)
              : waiting && waiting !== mono.turnId
              ? `Đang chờ ${nameOf(state, waiting)} trả nợ`
              : mine
              ? VI.afterTurns(mine)
              : state.you.spectator
              ? VI.watching
              : askOf(mono),
          }),
        ]),
      ]),
    );
  }

  if (mono.autoAt && waiting) {
    const machine = mono.autoIds.includes(waiting);
    bits.push(
      el("span", {
        class: `turn-clock${machine ? " machine" : ""}`,
        title: machine
          ? `${nameOf(state, waiting)} đang để máy chơi hộ`
          : `Chưa trả lời thì bàn tự chơi giúp — ${
            mono.pending.kind === "end" ? AUTO_END_MS / 1000 : AUTO_IDLE_MS / 1000
          } giây`,
      }, [
        el("span", { "aria-hidden": "true", text: machine ? "🤖" : "⏳" }),
        el("span", { class: "tiny-text", text: ` ${VI.autoIn} ` }),
        el("span", { class: "clock-num", "data-until": String(mono.autoAt), text: "…" }),
      ]),
    );
  }

  // "I am still here" — the clock restarts, and nothing else happens. Only worth
  // offering while it is your clock running down.
  if (onYou && !state.you.spectator) {
    bits.push(
      el("button", {
        class: "ghost tiny",
        title: "Đặt lại đồng hồ — bạn vẫn đang suy nghĩ",
        text: `⏸ ${VI.stillHere}`,
        onClick: () => ctx.actions.mono({ a: "hold" }),
      }),
    );
  }

  bits.push(el("span", { class: "spacer" }));
  bits.push(viewSwitch(ctx));
  bits.push(autoToggle(ctx));

  return el("div", {
    class: `turn-bar${yours ? " mine" : ""}${mono.winnerId ? " done" : ""}`,
    style: `--who-hue:${seat?.hue ?? 212}`,
  }, [
    el("div", { class: "turn-row" }, bits),
    queue.length > 1
      ? el("div", { class: "turn-queue" }, [
        el("span", { class: "tiny-text muted", text: `${VI.nextUp}:` }),
        ...queue.slice(1),
      ])
      : null,
  ]);
}

/**
 * What a watcher sees instead of a hand of cards.
 *
 * Joining a board that has already been dealt used to be refused outright, which
 * is a closed door to somebody holding a room code. Now they get a chair: the
 * whole game, the chat, and one button — ask the table to deal a new one, and
 * they are in it.
 */
function watchingBanner(ctx, mono) {
  return el("div", { class: "watch-banner" }, [
    el("span", { class: "wb-eye", "aria-hidden": "true", text: "👀" }),
    el("div", {}, [
      el("strong", { text: VI.watching }),
      el("small", { class: "muted", text: ` ${VI.watchingNote}` }),
    ]),
    el("span", { class: "spacer" }),
    mono.restart ? null : restartButton(ctx),
  ]);
}

/**
 * The "play for me" switch.
 *
 * A real checkbox, because that is what it is, and it is on screen all game
 * rather than appearing when the clock runs out — the point is to tick it
 * *before* you get up to answer the door. The board ticks it for you after
 * twenty seconds of silence; making a move unticks it.
 */
function autoToggle(ctx) {
  const on = Boolean(ctx.state.you.auto);
  return el("label", { class: `auto-switch${on ? " on" : ""}`, title: VI.autoNote }, [
    el("input", {
      type: "checkbox",
      checked: on,
      onChange: (e) => ctx.actions.monoAuto(e.target.checked),
    }),
    el("span", { "aria-hidden": "true", text: "🤖" }),
    el("span", { class: "tiny-text", text: on ? VI.autoOn : VI.autoLabel }),
  ]);
}

/**
 * Where you are standing, in words.
 *
 * On the flat board your piece is a coloured disc a few millimetres across on a
 * grid of forty, and "which building am I on" turned out to be a question people
 * could not answer from it. So the board says it: the square, its colour group,
 * who owns it and what it costs to land there — and tapping it opens the deed.
 */
function hereBar(ctx, mono) {
  const { state, local } = ctx;
  const seat = seatOf(mono, state.you.id);
  const bits = [];

  const chip = (label, space, cls) => {
    const group = groupOf(mono, space);
    const owner = space.ownerId ? seatOf(mono, space.ownerId) : null;
    return el("button", {
      type: "button",
      class: `here-chip ${cls}`,
      style: group ? `--band:${group.color}` : "",
      title: "Mở chi tiết ô này",
      onClick: () => {
        local.monoSelected = space.i;
        updateMonoRoom(ctx);
      },
    }, [
      el("span", { class: "here-label tiny-text", text: label }),
      el("span", { class: "here-icon", "aria-hidden": "true", text: space.icon }),
      el("strong", { class: "here-name", text: space.name }),
      group ? el("span", { class: "here-band", title: group.name }) : null,
      el("span", { class: "here-note tiny-text muted", text: hereNote(ctx, mono, space, owner) }),
    ]);
  };

  if (seat) {
    const space = mono.spaces[seat.pos];
    if (space) bits.push(chip(`📍 ${VI.here}${seat.inJail ? " (trong tù)" : ""}`, space, "you"));
  }
  if (mono.turnId && mono.turnId !== state.you.id) {
    const other = seatOf(mono, mono.turnId);
    const space = other ? mono.spaces[other.pos] : null;
    if (space) {
      bits.push(
        chip(`${other.token} ${VI.theirTurnHere} · ${nameOf(state, other.id)}`, space, "them"),
      );
    }
  }
  if (!bits.length) return null;
  return el("div", { class: "here-bar" }, bits);
}

/** One line about a square: whose it is and what it would cost. */
function hereNote(ctx, mono, space, owner) {
  if (space.ownerId === ctx.state.you.id) {
    const built = space.level ? ` · ${buildingGlyphs(space.level)}` : "";
    return `của bạn${built}`;
  }
  if (owner) {
    return `của ${nameOf(ctx.state, owner.id)}${
      space.mortgaged
        ? " · đang thế chấp"
        : space.rent !== undefined
        ? ` · thuê ${money(mono, space.rent)}`
        : ""
    }`;
  }
  if (space.price !== undefined) return `${VI.free} · ${money(mono, space.price)}`;
  return KIND_LABEL[space.kind]?.label ?? "";
}

/**
 * The open "shall we start over?" vote.
 *
 * Every seated player has to agree, and one no closes it. Shown at the top of
 * the stage rather than in a modal: it is a question to the table, and burying a
 * question to the table behind a dialog on four separate screens is how a vote
 * stalls for ten minutes.
 */
function restartPanel(ctx, mono) {
  const vote = mono.restart;
  if (!vote) return null;
  const { state, actions } = ctx;
  const you = state.you.id;
  const seated = !state.you.spectator;
  const answered = vote.yesIds.includes(you) || vote.noIds.includes(you);
  const name = (id) => nameOf(state, id);
  return el("div", { class: "restart-vote" }, [
    el("div", { class: "rv-head" }, [
      el("strong", { text: `🔁 ${VI.restartTitle}` }),
      el("small", { class: "muted", text: `${name(vote.byId)} đề nghị chia bàn mới.` }),
    ]),
    el("div", { class: "rv-tally" }, [
      el("span", { class: "chip ok", text: `👍 ${vote.yesIds.map(name).join(", ") || "—"}` }),
      vote.pendingIds.length
        ? el("span", {
          class: "chip",
          text: `⏳ ${VI.waitingVote}: ${vote.pendingIds.map(name).join(", ")}`,
        })
        : null,
    ]),
    seated && !answered
      ? el("div", { class: "rv-acts" }, [
        el("button", {
          class: "primary",
          text: `👍 ${VI.agree}`,
          onClick: () => actions.monoRestartVote(true),
        }),
        el("button", { text: `👎 ${VI.disagree}`, onClick: () => actions.monoRestartVote(false) }),
      ])
      : el("small", {
        class: "muted",
        text: seated ? "Đã ghi phiếu của bạn." : "Người xem không có phiếu.",
      }),
  ]);
}

// --- lobby -----------------------------------------------------------------

function lobbyBanner(ctx) {
  const { state } = ctx;
  const enough = state.players.length >= LIMITS.minBoardPlayers;
  const summary = state.monoMaps?.find((m) => m.id === state.config.monoMap);
  return el("div", { class: "banner-inner" }, [
    el("span", { class: "big", text: summary ? `${summary.icon} ${summary.name}` : "🗺️ Bàn cờ" }),
    el("span", {
      class: "muted",
      text: enough ? (state.you.isHost ? "Sẵn sàng — bấm Bắt đầu" : VI.waiting) : VI.needTwo,
    }),
  ]);
}

function lobbyStage(ctx) {
  const { state, local, actions } = ctx;
  const isHost = state.you.isHost;
  const maps = state.monoMaps ?? [];

  const mapPick = el(
    "div",
    { class: "mode-pick" },
    maps.map((m) =>
      el("button", {
        type: "button",
        disabled: !isHost,
        "aria-pressed": String(state.config.monoMap === m.id),
        onClick: () => actions.config({ monoMap: m.id }),
      }, [
        el("strong", { text: `${m.icon} ${m.name}` }),
        el("small", {
          text: m.custom ? `📂 ${VI.mapLoaded}` : (m.region ? `${m.region} — ${m.note}` : m.note),
        }),
      ])
    ),
  );

  const rules = el(
    "div",
    { class: "rule-list" },
    Object.entries(VI.rules).map(([key, info]) => {
      const field = configKeyFor(key);
      const box = el("input", {
        type: "checkbox",
        checked: Boolean(state.config[field]),
        disabled: !isHost,
        onChange: (e) => actions.config({ [field]: e.target.checked }),
      });
      return el("label", { class: "rule-row" }, [
        box,
        el("span", { class: "rule-icon", "aria-hidden": "true", text: info.icon }),
        el("span", {}, [
          el("strong", { text: info.label }),
          el("small", { class: "muted", text: info.note }),
        ]),
      ]);
    }),
  );

  const blocks = [
    el("div", { class: "field" }, [
      el("label", { text: `🗺️ ${VI.pickMap}` }),
      mapPick,
    ]),
    el("div", { class: "field" }, [
      el("label", { text: `📜 ${VI.houseRules}` }),
      rules,
    ]),
  ];

  if (isHost) blocks.push(mapLoader(ctx));

  blocks.push(
    el("div", { class: "field" }, [
      el("label", {
        text: `👥 ${VI.players} — ${state.players.length}/${LIMITS.maxBoardPlayers} ${VI.seats}`,
      }),
      el(
        "div",
        { class: "mono-seats" },
        state.players.map((p) =>
          el("span", { class: `seat${p.id === state.you.id ? " you" : ""}` }, [
            el("span", { text: p.nickname }),
            p.isHost ? el("span", { class: "badge host", text: "chủ bàn" }) : null,
          ])
        ),
      ),
    ]),
  );

  if (isHost) {
    blocks.push(
      el("button", {
        class: "primary",
        style: "width:100%",
        disabled: state.players.length < LIMITS.minBoardPlayers,
        text: `🎲 ${VI.start}`,
        onClick: () => actions.start(),
      }),
    );
  } else {
    blocks.push(el("div", { class: "muted tiny-text", text: VI.waiting }));
  }

  if (local.monoMapResult) {
    blocks.push(mapResultNote(local.monoMapResult));
  }
  return blocks;
}

/**
 * Loading a board from a file.
 *
 * A file picker *and* a paste box, because both are how people actually have
 * one: a JSON file they were sent, or a block of text in a chat message. The
 * template button hands them the board currently in play as a starting point,
 * which is a far better first step than a blank file and a schema to read.
 */
function mapLoader(ctx) {
  const { actions, local } = ctx;

  const area = el("textarea", {
    id: "monoMapPaste",
    rows: 4,
    placeholder: VI.orPaste,
    value: local.monoMapDraft ?? "",
    spellcheck: "false",
    onInput: (e) => (local.monoMapDraft = e.target.value),
  });

  const file = el("input", {
    type: "file",
    accept: ".json,application/json",
    id: "monoMapFile",
    onChange: (e) => {
      const chosen = e.target.files?.[0];
      if (!chosen) return;
      const reader = new FileReader();
      reader.onload = () => {
        local.monoMapDraft = String(reader.result ?? "");
        actions.loadMonoMap(local.monoMapDraft);
      };
      reader.onerror = () => actions.toastLocal("Không đọc được tệp.", "error");
      reader.readAsText(chosen);
      // Cleared so choosing the same file twice still fires a change.
      e.target.value = "";
    },
  });

  // Folded away, and labelled as optional. Four boards ship and one of them is
  // already selected above, so this is a thing to go looking for rather than a
  // step in setting a game up — sitting open in the lobby it read as one, which
  // is a fair thing to have been confused by.
  return el("details", {
    class: "field mono-maker",
    // Opened by a result too: the answer to "dùng bản đồ này" is rendered below,
    // and folding the box away over the top of it would hide the reply.
    open: local.monoMapOpen === true || Boolean(local.monoMapResult),
    onToggle: (e) => (local.monoMapOpen = e.target.open),
  }, [
    el("summary", {}, [
      el("span", { text: `📂 ${VI.loadMap}` }),
      el("small", { class: "muted tiny-text", text: VI.loadMapHint }),
    ]),
    el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
      file,
      el("button", {
        type: "button",
        text: `⬇️ ${VI.downloadTemplate}`,
        onClick: () => actions.downloadMonoTemplate(),
      }),
    ]),
    area,
    el("button", {
      type: "button",
      style: "width:100%",
      text: `✅ ${VI.applyMap}`,
      onClick: () => actions.loadMonoMap(local.monoMapDraft ?? ""),
    }),
    el("small", {
      class: "muted tiny-text",
      text: "Chỉ cần 22 địa điểm (rẻ nhất trước), 4 ô giao thông, 2 tiện ích và 8 nhóm màu. " +
        "Giá và tiền thuê do bàn cờ quyết định, bạn không phải nhập.",
    }),
  ]);
}

function mapResultNote(result) {
  const warnings = result.warnings ?? [];
  // A board that loaded with notes still loaded. Saying so and then listing the
  // notes is the honest order; leading with the complaints would read as failure.
  if (result.ok) {
    return el("div", { class: "notice good" }, [
      el("strong", { text: `✅ ${VI.mapLoaded}: ${result.name}` }),
      warnings.length
        ? el("ul", { class: "map-errors" }, warnings.map((line) => el("li", { text: line })))
        : null,
    ]);
  }
  return el("div", { class: "notice warn" }, [
    el("strong", { text: `⚠️ ${VI.mapProblems}` }),
    el(
      "ul",
      { class: "map-errors" },
      [...result.errors, ...warnings].map((line) => el("li", { text: line })),
    ),
  ]);
}

// --- the throw -------------------------------------------------------------

/** How long the dice tumble for, and how often the faces change while they do. */
const TUMBLE_MS = 620;
const TUMBLE_STEP_MS = 70;

/**
 * The state of the throw currently on screen.
 *
 * `roll` is the last `rollNo` seen: `-1` means "we have not seen this game's
 * dice yet", which is how somebody who joins or reloads mid-game gets the
 * current faces without a throw that already happened being re-enacted at them.
 */
const tumble = { roll: -1, timer: 0, until: 0, faces: null };

function randomFace() {
  return 1 + Math.floor(Math.random() * 6);
}

/** True while the dice on screen should be showing nonsense. */
function tumbling() {
  return tumble.until > Date.now();
}

/**
 * Start a throw, if this snapshot carries one.
 *
 * The result was decided on the server and is already in `mono.dice` — this is
 * cosmetic, and deliberately short. But a number that simply appears is not a
 * roll, and the whole game rests on believing the dice.
 *
 * Driven by `rollNo` rather than by the faces, because 3–4 twice in a row is two
 * throws that look identical. Somebody who has asked for less motion gets the
 * result with no tumble at all — `motionWanted` covers both the OS setting and
 * this app's own switch.
 */
function throwDice(ctx, mono) {
  // First sight of this game: take the tally as the baseline and animate
  // nothing. On a board that just started that is zero, so the very first throw
  // still gets thrown; on one already in progress it is whatever has happened
  // so far, which is not somebody's business to watch re-enacted on arrival.
  if (tumble.roll === -1) {
    tumble.roll = mono.rollNo;
    tumble.faces = mono.dice;
    return;
  }
  if (!mono.dice || mono.rollNo === tumble.roll) return;
  tumble.roll = mono.rollNo;
  tumble.faces = mono.dice;
  clearInterval(tumble.timer);
  tumble.timer = 0;
  if (!motionWanted()) {
    tumble.until = 0;
    return;
  }
  // On the 3D board the dice are objects that get thrown onto it, which is the
  // same event told better; two throws at once would be two throws.
  if (viewMode(ctx) === "2d") showBigThrow(mono.dice);
  tumble.until = Date.now() + TUMBLE_MS;
  // The banner is rebuilt from every snapshot, so the node this throw starts on
  // is very often not the node it lands on. Look it up each tick rather than
  // holding one — and paint the landing from here too, since a throw that ends
  // between snapshots would otherwise keep its nonsense faces until the next one.
  tumble.timer = setInterval(() => {
    const node = $("monoDice");
    if (!node) return;
    if (tumbling()) {
      paintFaces(node, [randomFace(), randomFace()]);
      return;
    }
    clearInterval(tumble.timer);
    tumble.timer = 0;
    node.classList.remove("rolling");
    node.classList.add("landed");
    paintFaces(node, tumble.faces);
  }, TUMBLE_STEP_MS);
}

/**
 * The throw, big, in the middle of the board.
 *
 * The dice in the top bar are a readout — they tell you what was rolled, in the
 * corner, at the size of a word. That is the wrong size for the one moment of
 * the turn everybody is actually waiting on, so the throw also happens here: two
 * dice the size of a fist, over the middle of the board, tumbling and then
 * landing with the total.
 *
 * Driven imperatively rather than rendered from state, and mounted in a layer
 * the snapshot pass never touches. A throw takes about a second and a half and
 * three snapshots can easily arrive inside it; anything rebuilt on snapshot
 * cannot animate across one.
 */
const BIG_TUMBLE_MS = 720;
const BIG_HOLD_MS = 950;

let bigThrow = null;

function showBigThrow(faces) {
  const layer = $("monoFx");
  if (!layer) return;
  clearTimeout(bigThrow?.spin);
  clearTimeout(bigThrow?.gone);
  clearInterval(bigThrow?.tick);

  const dice = [
    el("span", { class: "big-die", html: dieSvg(faces[0]) }),
    el("span", { class: "big-die", html: dieSvg(faces[1]) }),
  ];
  const total = el("span", { class: "big-total", text: String(faces[0] + faces[1]) });
  const stage = el("div", { class: "throw-stage rolling", "aria-hidden": "true" }, [
    el("div", { class: "throw-dice" }, dice),
    total,
  ]);
  // Appended, and only ever removing its own node. The layer is shared with the
  // walking pieces and the Khí vận reveal, and emptying it wholesale would take a
  // piece off the board mid-hop.
  dropThrowStage();
  layer.append(stage);

  const tick = setInterval(() => {
    dice[0].innerHTML = dieSvg(randomFace());
    dice[1].innerHTML = dieSvg(randomFace());
  }, TUMBLE_STEP_MS);

  const spin = setTimeout(() => {
    clearInterval(tick);
    dice[0].innerHTML = dieSvg(faces[0]);
    dice[1].innerHTML = dieSvg(faces[1]);
    stage.classList.remove("rolling");
    stage.classList.add("landed");
    landingNoise();
  }, BIG_TUMBLE_MS);

  const gone = setTimeout(() => {
    stage.classList.add("leaving");
    // Long enough for the fade in the stylesheet, then gone: a layer holding a
    // finished animation is a layer over the board.
    setTimeout(() => stage.remove(), 260);
  }, BIG_TUMBLE_MS + BIG_HOLD_MS);

  bigThrow = { tick, spin, gone };
  rattleNoise();
}

/** Dice in a cup. Five short bursts of filtered noise, and it is unmistakable. */
function rattleNoise() {
  if (!motionWanted()) return;
  for (let n = 0; n < 5; n++) {
    noise({ at: n * 0.055, dur: 0.045, gain: 0.05, freq: 2400, q: 0.9 });
  }
}

function landingNoise() {
  if (!motionWanted()) return;
  noise({ at: 0, dur: 0.13, gain: 0.15, freq: 430, q: 1.1 });
  blip({ at: 0.03, freq: 196, dur: 0.14, gain: 0.07, type: "sine" });
}

/** Clear a throw in progress, when the room goes away underneath it. */
function forgetBigThrow() {
  clearTimeout(bigThrow?.spin);
  clearTimeout(bigThrow?.gone);
  clearInterval(bigThrow?.tick);
  bigThrow = null;
  dropThrowStage();
}

function dropThrowStage() {
  for (const node of document.querySelectorAll("#monoFx .throw-stage")) node.remove();
}

// --- Khí vận, the lucky draw ------------------------------------------------

/** How long the reveal spins before it settles, and how long it then stays. */
const GACHA_SPIN_MS = 800;
const GACHA_HOLD_MS = 1800;
/**
 * How long to leave the dice alone first.
 *
 * A card is always the consequence of a throw, and both are in the same snapshot,
 * so without this they would animate over each other in the middle of the board.
 * Long enough to watch the dice land and read them, and then the dice get out of
 * the way — the total is still in the top bar.
 */
const GACHA_WAIT_MS = BIG_TUMBLE_MS + 300;

/** The faces the reveal riffles through. Deliberately the loud ones. */
const GACHA_SPIN = ["🧧", "💎", "🏗️", "🎰", "🎁", "🔄", "🧨", "🛡️", "🎂", "🚕", "💊", "🏦"];

const TIER_LOOK = new Map(CHEST_TIERS.map((tier) => [tier.id, tier]));

/**
 * Cards this browser has already reacted to.
 *
 * `-1` means no baseline yet: the first snapshot of a room takes whatever is on
 * the table as the state of play rather than as a draw to re-enact, the same way
 * the dice do. After that, a higher serial is a fresh draw.
 */
let gachaSeen = -1;
let gacha = null;

function revealCard(ctx, mono) {
  const no = mono.card?.no ?? 0;
  if (gachaSeen < 0) {
    gachaSeen = no;
    return;
  }
  if (no <= gachaSeen) return;
  gachaSeen = no;
  // Cơ hội is the printed deck and reads as a card on the table. Khí vận is a
  // lucky draw, and a draw with no reveal is just a smaller number.
  const card = mono.card;
  if (!card || card.deck !== "chest" || !motionWanted()) return;
  clearTimeout(gacha?.open);
  const open = setTimeout(() => showGacha(ctx, card), GACHA_WAIT_MS);
  gacha = { ...(gacha ?? {}), open };
}

function showGacha(ctx, card) {
  const layer = $("monoFx");
  if (!layer) return;
  clearTimeout(gacha?.settle);
  clearTimeout(gacha?.gone);
  clearInterval(gacha?.tick);
  for (const node of layer.querySelectorAll(".gacha")) node.remove();
  // The dice have been read by now, and two animations in the middle of one
  // board is one too many.
  dropThrowStage();

  const tier = TIER_LOOK.get(card.tier) ?? { icon: "🧧", name: "Khí vận" };
  const face = el("span", { class: "gacha-face", text: "🧧" });
  const rarity = el("small", { class: "gacha-tier", text: "…" });
  const words = el("p", { class: "gacha-words", text: "" });
  const stage = el("div", {
    class: `gacha rolling t-${card.tier ?? "common"}`,
    "aria-hidden": "true",
  }, [
    el("div", { class: "gacha-head" }, [
      el("span", { "aria-hidden": "true", text: "🧧" }),
      el("strong", { text: "Khí vận" }),
      el("small", { class: "muted", text: nameOf(ctx.state, card.forId) }),
    ]),
    face,
    rarity,
    words,
  ]);
  layer.append(stage);

  let at = 0;
  const tick = setInterval(() => {
    face.textContent = GACHA_SPIN[at++ % GACHA_SPIN.length];
  }, 70);

  const settle = setTimeout(() => {
    clearInterval(tick);
    face.textContent = card.icon;
    rarity.textContent = `${tier.icon} ${tier.name}`;
    words.textContent = card.text;
    stage.classList.remove("rolling");
    stage.classList.add("landed");
    gachaNoise(card.tier);
  }, GACHA_SPIN_MS);

  const gone = setTimeout(() => {
    stage.classList.add("leaving");
    setTimeout(() => stage.remove(), 300);
  }, GACHA_SPIN_MS + GACHA_HOLD_MS);

  gacha = { tick, settle, gone, open: gacha?.open };
}

/** A rising run of notes, one more for every step up the rarity ladder. */
function gachaNoise(tier) {
  if (!motionWanted()) return;
  const notes = { common: 1, rare: 2, epic: 3, legend: 5 }[tier] ?? 1;
  for (let n = 0; n < notes; n++) {
    blip({ at: n * 0.11, freq: 520 * Math.pow(1.19, n), dur: 0.13, gain: 0.13 });
  }
}

function forgetGacha() {
  clearTimeout(gacha?.open);
  clearTimeout(gacha?.settle);
  clearTimeout(gacha?.gone);
  clearInterval(gacha?.tick);
  gacha = null;
  gachaSeen = -1;
  for (const node of document.querySelectorAll("#monoFx .gacha")) node.remove();
}

/** Forget the throw on screen: a new room, or the same room walked into again. */
function forgetDice() {
  clearInterval(tumble.timer);
  tumble.timer = 0;
  tumble.until = 0;
  tumble.roll = -1;
  tumble.faces = null;
  forgetBigThrow();
  forgetWalks();
  forgetGacha();
}

// --- the flat board, moving -------------------------------------------------

/**
 * Where every piece was the last time the board drew, and what it was holding.
 *
 * The 3D board has walked its pawns a square at a time since it existed, and
 * that walk is doing real work: it is what tells you a six is a six without
 * reading the number, and what makes passing Xuất phát something you see rather
 * than something the feed mentions afterwards. The flat board teleported. A disc
 * vanished from one cell of forty and reappeared eleven cells away, in the same
 * frame as three other things changed, and the one question a board has to be
 * able to answer — what just happened — was answerable only by reading.
 *
 * So it walks here too, off the same numbers and the same timings, using the one
 * thing the flat board has that the scene does not: its squares are elements
 * with rectangles, so a piece can be flown between them by reading the layout
 * rather than by modelling it. Everything is measured per frame, which is what
 * keeps it right across a resize, a re-render, or a board that reflowed under it.
 */
const flatSeen = new Map();
const flatCash = new Map();
/** Walks in flight, by player id. The render reads this so a walker is drawn once. */
const flatWalks = new Map();
let flatBoardKey = "";
let flatRoll = -1;

/** One hop, and one arc for a jump. The 3D board's numbers, so both boards move alike. */
const FLAT_HOP_MS = 165;
const FLAT_JUMP_MS = 620;

/**
 * Read a snapshot as movement, and animate the difference.
 *
 * Called after the board is in the page, because all of this is measured off the
 * squares themselves. Positions are recorded whichever board is showing, so
 * switching to the flat one does not replay a move that already happened in 3D.
 */
function walkFlat(ctx, mono) {
  if (mono.map.id !== flatBoardKey || mono.rollNo < flatRoll) forgetWalks();
  flatBoardKey = mono.map.id;
  flatRoll = mono.rollNo;

  const live = mono.players.filter((p) => !p.bankrupt);
  const flat = viewMode(ctx) !== "3d";
  const total = mono.spaces.length;

  for (const player of live) {
    const wasAt = flatSeen.get(player.id);
    const wasCash = flatCash.get(player.id);
    flatSeen.set(player.id, player.pos);
    flatCash.set(player.id, player.cash);
    // The first sight of a game is the state of play, not a move: somebody who
    // joins on turn forty should not watch forty turns re-enacted at them.
    if (wasAt === undefined) continue;
    if (!flat || !motionWanted()) continue;
    if (wasAt !== player.pos) startFlatWalk(ctx, mono, player, wasAt, total, live);
    if (wasCash !== undefined && wasCash !== player.cash) {
      // Money moving is most of what happens in this game, and on the flat board
      // none of it was visible: rent, salary and a purchase were a line in the
      // feed and a different number in the sidebar. Held back until the piece
      // arrives, so the number lands where the player does.
      const walk = flatWalks.get(player.id);
      const delta = player.cash - wasCash;
      if (walk) walk.owed = (walk.owed ?? 0) + delta;
      else floatFlatMoney(mono, player, player.pos, delta);
    }
  }

  // Anybody off the board takes their walk with them.
  for (const id of [...flatSeen.keys()]) {
    if (live.some((p) => p.id === id)) continue;
    flatSeen.delete(id);
    flatCash.delete(id);
    endFlatWalk(id);
  }
  hideWalkers();
}

function startFlatWalk(ctx, mono, player, from, total, live) {
  endFlatWalk(player.id);
  const layer = $("monoFx");
  if (!layer) return;

  // Twelve squares is the most two dice and a double can carry you, so anything
  // further is not a walk: a card that sends you across the board, or the police
  // van to jail. Those arc straight there, because eleven hops backwards would
  // be a lie about what happened.
  const forward = (player.pos - from + total) % total;
  const steps = [];
  if (forward > 0 && forward <= 12) {
    for (let n = 1; n <= forward; n++) steps.push((from + n) % total);
  } else {
    steps.push(player.pos);
  }

  const node = el("span", { class: "walk-fly", "aria-hidden": "true" }, [
    el("span", {
      class: `tok${player.id === ctx.state.you.id ? " mine" : ""}`,
      style: `--tok-hue:${hueFor(player.id)}`,
      text: player.token,
    }),
  ]);
  // Appended before anything is measured: the layer is `display:none` while it is
  // empty, and an element with no box has no rectangle to measure against.
  layer.append(node);

  const seat = live.indexOf(player);
  const walk = {
    node,
    steps,
    seat,
    count: live.length,
    at: 0,
    t0: 0,
    arc: steps.length === 1,
    dur: steps.length === 1 ? FLAT_JUMP_MS : FLAT_HOP_MS,
    from: squareSpot(from, seat, live.length),
    raf: 0,
  };
  if (!walk.from) {
    node.remove();
    return;
  }
  flatWalks.set(player.id, walk);
  walk.raf = requestAnimationFrame((now) => stepFlatWalk(mono, player.id, now));
}

function stepFlatWalk(mono, id, now) {
  const walk = flatWalks.get(id);
  if (!walk) return;
  if (!walk.t0) walk.t0 = now;
  const target = squareSpot(walk.steps[walk.at], walk.seat, walk.count);
  // The board went away underneath it — a new game, the other board, a resize
  // mid-hop. Land it rather than leaving a piece parked over the page.
  if (!target) {
    endFlatWalk(id);
    return;
  }

  const leg = Math.min(1, (now - walk.t0) / walk.dur);
  const eased = walk.arc ? leg * leg * (3 - 2 * leg) : leg;
  const x = walk.from.x + (target.x - walk.from.x) * eased;
  const y = walk.from.y + (target.y - walk.from.y) * eased;
  // A hop, so a run of them reads as steps rather than as a slide. Higher on a
  // jump, which is one long arc instead of many small ones.
  const lift = Math.sin(leg * Math.PI) * (walk.arc ? 30 : 10);
  walk.node.style.transform = `translate(${x}px, ${y - lift}px) translate(-50%, -50%)`;

  if (leg < 1) {
    walk.raf = requestAnimationFrame((next) => stepFlatWalk(mono, id, next));
    return;
  }
  walk.at++;
  if (walk.at >= walk.steps.length) {
    const landed = walk.steps[walk.steps.length - 1];
    flashSquare(landed);
    const owed = walk.owed;
    endFlatWalk(id);
    if (owed) {
      const player = mono.players.find((p) => p.id === id);
      if (player) floatFlatMoney(mono, player, landed, owed);
    }
    return;
  }
  walk.from = target;
  walk.t0 = now;
  walk.raf = requestAnimationFrame((next) => stepFlatWalk(mono, id, next));
}

function endFlatWalk(id) {
  const walk = flatWalks.get(id);
  if (!walk) return;
  cancelAnimationFrame(walk.raf);
  walk.node.remove();
  flatWalks.delete(id);
  for (const node of pieceNodes(id)) node.classList.remove("walking");
}

function forgetWalks() {
  for (const id of [...flatWalks.keys()]) endFlatWalk(id);
  flatSeen.clear();
  flatCash.clear();
  flatBoardKey = "";
  flatRoll = -1;
}

/**
 * Hide the piece of anybody mid-walk, so there is one of them rather than two.
 *
 * Done to the page after it is drawn rather than by leaving the piece out of the
 * render, because a walk starts *after* a render — the render is what tells us
 * somebody moved — and a second render to hide one disc would be a second render
 * for every hop.
 */
function hideWalkers() {
  for (const id of flatWalks.keys()) {
    for (const node of pieceNodes(id)) node.classList.add("walking");
  }
}

function pieceNodes(id) {
  const key = globalThis.CSS?.escape ? CSS.escape(id) : id;
  return document.querySelectorAll(`.sq-here .tok[data-pid="${key}"]`);
}

/**
 * Where a piece stands on a square, in the effects layer's own coordinates.
 *
 * Measured rather than computed: the grid decides how big a square is, at four
 * different widths, and reading it back is the only version of this that cannot
 * drift from what is on screen. Pieces sit along the bottom of a cell and fan out
 * by seat, the way they do inside the square itself.
 */
function squareSpot(index, seat = 0, count = 1) {
  const layer = $("monoFx");
  const cell = document.querySelector(`.mono-board .sq[data-i="${index}"]`);
  if (!layer || !cell) return null;
  const base = layer.getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  if (!box.width) return null;
  const spread = count > 1 ? (seat - (count - 1) / 2) * Math.min(11, box.width / (count + 1)) : 0;
  return {
    x: box.left - base.left + box.width / 2 + spread,
    y: box.top - base.top + box.height - Math.min(17, box.height * 0.26),
  };
}

/** A square, hit. Brief, because the piece standing on it is the lasting mark. */
function flashSquare(index) {
  const cell = document.querySelector(`.mono-board .sq[data-i="${index}"]`);
  if (!cell) return;
  cell.classList.add("just-landed");
  setTimeout(() => cell.classList.remove("just-landed"), 640);
}

/** What it cost, or what it paid, floating up off the square it happened on. */
function floatFlatMoney(mono, player, index, delta) {
  const layer = $("monoFx");
  if (!layer || !delta || !motionWanted()) return;
  const node = el("span", {
    class: `flat-float ${delta > 0 ? "up" : "down"}`,
    "aria-hidden": "true",
    style: `--tok-hue:${hueFor(player.id)}`,
    text: `${delta > 0 ? "+" : "−"}${money(mono, Math.abs(delta))}`,
  });
  layer.append(node);
  const spot = squareSpot(index);
  if (!spot) {
    node.remove();
    return;
  }
  node.style.transform = `translate(${spot.x}px, ${spot.y}px) translate(-50%, -50%)`;
  setTimeout(() => node.remove(), 1500);
}

function paintFaces(node, faces) {
  const dice = node.querySelectorAll(".die");
  if (dice.length !== 2) return;
  dice[0].innerHTML = dieSvg(faces[0]);
  dice[1].innerHTML = dieSvg(faces[1]);
}

/**
 * The dice, mid-throw or landed.
 *
 * Rendered from the tumble state rather than straight from `mono.dice`, so a
 * snapshot that lands mid-throw — somebody else's chat line, say — rebuilds the
 * banner without stopping the dice dead on their result.
 */
function diceNode(mono) {
  const rolling = tumbling();
  const faces = rolling ? [randomFace(), randomFace()] : mono.dice;
  const total = mono.dice[0] + mono.dice[1];
  return el("span", {
    id: "monoDice",
    class: `mono-dice${rolling ? " rolling" : " landed"}`,
    title: rolling ? VI.rolling : `${VI.dice}: ${mono.dice[0]} + ${mono.dice[1]} = ${total}`,
  }, [
    el("span", { class: "die", "aria-hidden": "true", html: dieSvg(faces[0]) }),
    el("span", { class: "die", "aria-hidden": "true", html: dieSvg(faces[1]) }),
    // The total is the thing being waited on, so it stays hidden until the dice
    // stop — a number that changes while they tumble reads as noise. Hidden in
    // CSS rather than left out, so the landing only has to drop a class: the
    // throw can end between snapshots, with no rebuild coming to add it back.
    el("span", { class: "dice-total tiny-text", text: String(total) }),
  ]);
}
// --- the board -------------------------------------------------------------

function gameBanner(ctx, mono) {
  const { state } = ctx;
  const mine = seatOf(mono, state.you.id);
  const turn = mono.turnId;
  const yours = turn === state.you.id;

  const bits = [
    el("span", { class: "big" }, [
      el("span", { "aria-hidden": "true", text: mono.map.icon }),
      el("span", { text: ` ${mono.map.name}` }),
    ]),
  ];

  if (mono.winnerId) {
    bits.push(
      el("span", { class: "mono-win", text: `🏆 ${VI.won}: ${nameOf(state, mono.winnerId)}` }),
    );
  } else if (turn) {
    bits.push(
      el("span", { class: yours ? "mono-turn you" : "mono-turn" }, [
        el("span", { "aria-hidden": "true", text: seatOf(mono, turn)?.token ?? "🎲" }),
        el("span", { text: ` ${yours ? VI.yourTurn : `${VI.turnOf} ${nameOf(state, turn)}`}` }),
      ]),
    );
  }

  if (mono.dice) bits.push(diceNode(mono));

  if (mine) {
    bits.push(
      el("span", { class: "mono-cash" }, [
        el("span", { "aria-hidden": "true", text: "💵" }),
        el("span", { text: ` ${money(mono, mine.cash)}` }),
        el("span", { class: "muted tiny-text", text: ` · ${VI.worth} ${money(mono, mine.net)}` }),
      ]),
    );
    if (mine.jailCards > 0) {
      bits.push(el("span", { class: "chip", text: `🎫 ${mine.jailCards} ${VI.jailCards}` }));
    }
  }

  if (mono.pot !== null && mono.pot > 0) {
    bits.push(el("span", { class: "chip", text: `🅿️ ${VI.pot} ${money(mono, mono.pot)}` }));
  }
  bits.push(el("span", { class: "muted tiny-text", text: `${VI.round} ${mono.round}` }));
  return el("div", { class: "banner-inner" }, bits);
}

// --- which board -----------------------------------------------------------

/**
 * Whether this browser can do WebGL, asked once.
 *
 * The probe makes a canvas and a context to find out, which is not something to
 * do on every snapshot.
 */
let glChecked = null;

function glAvailable() {
  if (glChecked === null) glChecked = webglOk();
  return glChecked;
}

/**
 * The flat board or the 3D one.
 *
 * Three things can send somebody to the flat board: asking for it, a machine
 * with no WebGL, and a 3D board that tried and failed. The last two are not
 * announced — a board game that says "your graphics card is unsupported" instead
 * of dealing cards has its priorities wrong.
 */
function viewMode(ctx) {
  if (ctx.local.monoView === "2d") return "2d";
  if (!glAvailable() || boardFailed()) return "2d";
  // Nobody has said which they want: pick by how much room there is. A 3D board
  // on a phone is a beautiful thing with unreadable street names on it, and the
  // flat grid is the better game at that size.
  if (ctx.local.monoView !== "3d" && globalThis.innerWidth < 760) return "2d";
  return "3d";
}

/** The button that swaps them, sitting in the corner of whichever is showing. */
function viewSwitch(ctx) {
  const mode = viewMode(ctx);
  const to3d = mode === "2d";
  if (to3d && !glAvailable()) return null;
  return el("button", {
    type: "button",
    class: "view-switch",
    title: to3d ? "Bàn cờ 3D — kéo để xoay" : "Bàn cờ phẳng — xem được cả bàn cùng lúc",
    onClick: () => ctx.actions.monoView(to3d ? "3d" : "2d"),
  }, [
    el("span", { "aria-hidden": "true", text: to3d ? "🧊" : "🗺️" }),
    el("span", { text: to3d ? "3D" : "2D" }),
  ]);
}

/**
 * The 3D board's place in the page.
 *
 * The canvas itself is `boardHost()` — the same element every time, moved into
 * place rather than made again, because rebuilding it would throw away the scene
 * and its WebGL context on every snapshot.
 *
 * What normally sits in the hole in the middle of the flat board — the card just
 * drawn, the square somebody tapped — goes underneath instead. On a
 * 3D board the middle is where the dice land and where the emblem is painted
 * into the felt, and covering that with a panel would hide the best part.
 */
function board3d(ctx, mono) {
  ensureBoard(ctx, mono);
  return el("div", { class: "mono-3d-wrap" }, [
    boardHost(),
    el("div", { class: "board-under" }, boardMiddle(ctx, mono, { emblem: false })),
  ]);
}

/**
 * Keep the 3D board's ideas about the page in step with the page.
 *
 * Called once. A tap on a square has to redraw the panels the flat board would
 * have redrawn; a theme change has to repaint forty textures that have the ink
 * colour baked into them; and a board that turns out to be impossible has to put
 * the flat one back without anybody asking.
 */
let wired3d = false;

function wire3d(ctx) {
  if (wired3d) return;
  wired3d = true;
  // `ctx` is one object for the life of the page, with `state` behind a getter,
  // so holding it here is holding the live game rather than a stale copy of one.
  on3dPick(() => updateMonoRoom(ctx));
  on3dFail(() => updateMonoRoom(ctx));
  onPrefsChange(() => {
    if (ctx.state?.mono && viewMode(ctx) === "3d") repaintBoard(ctx, ctx.state.mono);
  });
  // Two layout decisions are made from the window width — which board `auto`
  // picks, and whether the deed card sits in the hole in the middle or under the
  // board — and neither is re-decided by a snapshot. Without this, resizing a
  // window while nobody is moving leaves the layout it was first drawn with.
  let shape = layoutShape();
  globalThis.addEventListener("resize", () => {
    const now = layoutShape();
    if (now === shape) return;
    shape = now;
    if (ctx.state?.mono) updateMonoRoom(ctx);
  });
}

/** The two width thresholds, as one string to compare against. */
function layoutShape() {
  const w = globalThis.innerWidth;
  return `${w < 900}:${w < 760}`;
}

function boardGrid(ctx, mono, tight = false) {
  const { local } = ctx;
  const total = mono.spaces.length;
  const side = (total + 4) / 4;
  const you = ctx.state.you.id;

  const squares = mono.spaces.map((space) => {
    const { row, col, edge } = ringPosition(space.i, total);
    const group = groupOf(mono, space);
    const owner = space.ownerId ? seatOf(mono, space.ownerId) : null;
    const here = mono.players.filter((p) => !p.bankrupt && p.pos === space.i);
    const yourSquare = here.some((p) => p.id === you);
    const turnSquare = here.some((p) => p.id === mono.turnId);
    const yourDeed = space.ownerId === you;

    const marks = [`sq k-${space.kind}`];
    if (space.mortgaged) marks.push("mortgaged");
    if (local.monoSelected === space.i) marks.push("picked");
    // Three separate questions, three separate marks: where am I, where is the
    // game, and what is mine. Answering the first from a disc a few millimetres
    // across was the thing people could not do.
    if (yourSquare) marks.push("you-here");
    if (turnSquare && !yourSquare) marks.push("turn-here");
    if (yourDeed) marks.push("mine-deed");

    return el("button", {
      type: "button",
      class: marks.join(" "),
      "data-edge": edge,
      // Read back by the walk, which flies a piece between real rectangles.
      "data-i": String(space.i),
      style: `grid-row:${row};grid-column:${col}` +
        (owner ? `;--own-hue:${hueFor(owner.id)}` : ""),
      title: `${space.name}${space.note ? ` — ${space.note}` : ""}${
        yourSquare ? " — bạn đang ở đây" : ""
      }`,
      onClick: () => {
        local.monoSelected = local.monoSelected === space.i ? null : space.i;
        updateMonoRoom(ctx);
      },
    }, [
      sceneNode(space, "sq-art"),
      group
        ? el("span", {
          class: "sq-band",
          style: `background:${group.color}`,
          title: `${group.icon} ${group.name}`,
        })
        : null,
      el("span", { class: "sq-icon", "aria-hidden": "true", text: space.icon }),
      el("span", { class: "sq-name", text: space.name }),
      space.price !== undefined
        ? el("span", { class: "sq-price", text: money(mono, space.price) })
        : null,
      space.level ? el("span", { class: "sq-built", text: buildingGlyphs(space.level) }) : null,
      // The owner's colour, not their emoji: a ribbon down the edge reads at a
      // glance and matches the same person's name in the feed.
      owner ? el("span", { class: "sq-own", title: nameOf(ctx.state, owner.id) }) : null,
      space.mortgaged ? el("span", { class: "sq-flag", text: "📄" }) : null,
      here.length
        ? el(
          "span",
          { class: `sq-here${here.length > 2 ? " crowded" : ""}` },
          here.map((p) => pieceNode(ctx, p, p.id === mono.turnId)),
        )
        : null,
      yourSquare ? el("span", { class: "sq-youmark", "aria-hidden": "true", text: "📍" }) : null,
    ]);
  });

  const middle = el("div", {
    class: `board-middle${tight ? " bare" : ""}`,
    style: `grid-row:2 / ${side};grid-column:2 / ${side}`,
  }, boardMiddle(ctx, mono, { detail: !tight }));

  // The ring gets much wider tracks than the hole in the middle.
  //
  // Equal tracks put nine cells of felt in the middle of a board of eleven, so
  // four fifths of the picture was empty and every square was too small to read.
  // A real board is nothing like that: the ring is the board. `--ring-track`
  // makes each edge track nearly twice an inner one, which shrinks the middle
  // and grows every square without touching the ring maths.
  const track = `var(--ring-track) repeat(${side - 2}, minmax(0, 1fr)) var(--ring-track)`;

  return el("div", {
    class: "mono-board",
    style: `grid-template-columns:${track};grid-template-rows:${track}`,
  }, [...squares, middle]);
}

/**
 * The flat board, and the corner button that swaps it for the other one.
 *
 * Also the layer a throw is drawn into: it has to be over the board and outside
 * the part of the page that is rebuilt on every snapshot, and the wrapper around
 * the grid is the one place that is both.
 */
function flatBoard(ctx, mono) {
  // On a narrow screen the hole in the middle of a 440px board is 330px across,
  // and a deed card with a picture on it is not 330px. So below that width the
  // card comes out of the board and sits under it — the same place the 3D board
  // keeps it — and the ring gets the whole width to be a ring in.
  //
  // No corner button any more either: the squares are large enough now that a
  // button floating over the top-right one covered a corner of the board, and
  // switching boards is a page control rather than a board one.
  const tight = globalThis.innerWidth < 900;
  return el("div", { class: "mono-flat-wrap" }, [
    boardGrid(ctx, mono, tight),
    tight ? el("div", { class: "board-under" }, boardMiddle(ctx, mono, { emblem: false })) : null,
  ]);
}

/**
 * The card and the selected square's detail: what needs reading.
 *
 * `emblem` is off for the 3D board, which paints the board's picture into the
 * felt and its name along the top — drawing them a second time in a panel over
 * the top would be the same two things twice.
 */
function boardMiddle(ctx, mono, { emblem = true, detail = true } = {}) {
  const { local } = ctx;
  const parts = emblem
    ? [
      emblemNode(mono),
      el("div", { class: "board-title" }, [
        el("span", { class: "board-icon", "aria-hidden": "true", text: mono.map.icon }),
        el("strong", { text: mono.map.name }),
        el("small", { class: "muted", text: mono.map.region || mono.map.note }),
      ]),
    ]
    : [];

  // `detail` off is the narrow flat board: the middle keeps the emblem and the
  // board's name, and everything that has to be read goes in a panel under it.
  if (!detail) return parts;

  if (mono.card) {
    parts.push(
      el("div", {
        class: `mono-card ${mono.card.deck}${mono.card.tier ? ` t-${mono.card.tier}` : ""}`,
      }, [
        el("div", { class: "card-head" }, [
          el("span", { "aria-hidden": "true", text: mono.card.deck === "chance" ? "🎲" : "🧧" }),
          el("strong", { text: mono.card.deck === "chance" ? "Cơ hội" : "Khí vận" }),
          // The rarity, where a Khí vận draw has one. It is the half of the draw
          // people react to, and the reveal that showed it has faded by now.
          mono.card.tier
            ? el("span", { class: "tier-chip" }, [
              el("span", {
                "aria-hidden": "true",
                text: TIER_LOOK.get(mono.card.tier)?.icon ?? "⚪",
              }),
              el("span", { text: TIER_LOOK.get(mono.card.tier)?.name ?? "" }),
            ])
            : null,
          el("small", { class: "muted", text: nameOf(ctx.state, mono.card.forId) }),
        ]),
        el("p", {}, [
          el("span", { class: "card-icon", "aria-hidden": "true", text: mono.card.icon }),
          el("span", { text: mono.card.text }),
        ]),
      ]),
    );
  }

  // Nothing tapped shows the square you are standing on, not a hint to tap
  // something. The middle of the board was a large empty rectangle for most of
  // the game, and the square under your own piece is the one thing that is
  // always worth reading there.
  const picked = local.monoSelected !== null && local.monoSelected !== undefined
    ? local.monoSelected
    : seatOf(mono, ctx.state.you.id)?.pos ?? null;
  if (picked !== null && mono.spaces[picked]) {
    parts.push(spaceDetail(ctx, mono, mono.spaces[picked]));
    if (picked !== local.monoSelected) {
      parts.push(
        el("div", {
          class: "muted tiny-text",
          text: "📍 Ô bạn đang đứng — bấm ô khác để xem ô đó.",
        }),
      );
    }
  } else {
    parts.push(
      el("div", { class: "muted tiny-text", text: "Bấm vào một ô để xem chi tiết." }),
    );
  }
  return parts;
}

function spaceDetail(ctx, mono, space) {
  if (!space) return null;
  const kind = KIND_LABEL[space.kind] ?? { icon: "📍", label: space.kind };
  const group = groupOf(mono, space);
  const rows = [];

  if (space.note) rows.push([kind.icon, space.note]);
  if (group) rows.push([group.icon || "🎨", `${group.name}`]);
  if (space.price !== undefined) rows.push(["🏷️", `${VI.price}: ${money(mono, space.price)}`]);
  if (space.houseCost !== undefined) {
    rows.push(["🏗️", `${VI.houseCost}: ${money(mono, space.houseCost)}`]);
  }
  if (space.ownerId) {
    const owner = seatOf(mono, space.ownerId);
    rows.push([owner?.token ?? "👤", `${VI.owner}: ${nameOf(ctx.state, space.ownerId)}`]);
  } else if (space.price !== undefined) {
    rows.push(["🆓", VI.free]);
  }
  if (space.level) rows.push(["🏠", levelLabel(space.level)]);
  if (space.mortgaged) rows.push(["📄", VI.mortgaged]);
  // Whether another storey can go up here right now, and if not, why not. The
  // reason is the interesting half: on this board a street whose colour group is
  // incomplete can still be built on, but only while its owner is standing on it.
  if (space.kind === "place" && space.ownerId) {
    rows.push(
      space.canBuild ? ["🔓", VI.unlockedBuild] : ["🔒", space.buildNote ?? ""],
    );
  }
  if (space.rent !== undefined) {
    rows.push(["💰", `${VI.rentNow}: ${money(mono, space.rent)}`]);
  }
  if (space.kind === "tax") {
    rows.push([
      "🧾",
      space.percent !== undefined
        ? `${money(mono, space.amount)} hoặc ${space.percent}% tài sản`
        : money(mono, space.amount),
    ]);
  }

  return el("div", { class: "space-detail" }, [
    sceneNode(space, "detail-art"),
    el("div", { class: "detail-head" }, [
      el("span", { class: "detail-icon", "aria-hidden": "true", text: space.icon }),
      el("div", {}, [
        el("strong", { text: space.name }),
        el("small", { class: "muted", text: `${kind.icon} ${kind.label} · ô ${space.i}` }),
      ]),
    ]),
    el(
      "div",
      { class: "detail-rows" },
      rows.map(([icon, text]) =>
        el("div", { class: "detail-row" }, [
          el("span", { "aria-hidden": "true", text: icon }),
          el("span", { text }),
        ])
      ),
    ),
  ]);
}

// --- what to do next -------------------------------------------------------

/**
 * The buttons for whatever the game is waiting on.
 *
 * Built from `pending` alone, so there is exactly one place that decides what
 * you can do and it is the same place the server decides it from. When the game
 * is waiting on somebody else this says who and offers nothing, which is the
 * honest answer — a greyed row of buttons reads as broken rather than as "not
 * your turn".
 */
function actionBar(ctx, mono) {
  const { state, actions } = ctx;
  const pending = mono.pending;
  const mine = pending.playerId === state.you.id;
  const act = (action) => actions.mono(action);

  const bar = el("div", { class: "mono-actions" });
  const button = (icon, label, action, opts = {}) =>
    el("button", {
      class: opts.primary ? "primary" : (opts.danger ? "danger" : ""),
      disabled: Boolean(opts.disabled),
      title: opts.title ?? "",
      text: `${icon} ${label}`,
      onClick: () => act(action),
    });

  if (mono.winnerId || pending.kind === "over") {
    append(bar, [
      el("span", { class: "act-say", text: `🏆 ${VI.gameOver}` }),
      state.you.isHost
        ? el("button", {
          class: "primary",
          text: `↩️ ${VI.playAgain}`,
          onClick: () => actions.next(),
        })
        : null,
    ]);
    return bar;
  }

  // Before the auction branch, because a watcher has no seat to bid from and
  // "you withdrew from the auction" is not true of somebody who was never in it.
  if (state.you.spectator) {
    // The banner above already says they are watching, so this says what the
    // table is doing instead of saying the same thing twice.
    append(bar, [
      el("span", {
        class: "act-say",
        text: mono.auction
          ? `🔨 ${VI.auction} — ${mono.spaces[mono.auction.space].name}`
          : `⏳ Đang chờ ${nameOf(state, pending.playerId)}…`,
      }),
      state.you.isHost ? hostEndButton(ctx) : null,
    ]);
    return bar;
  }

  // An auction suspends the turn, and the server refuses turn actions until it
  // is settled. The pending state underneath is still whatever it was, so
  // reading it here would offer the square for sale to the very player who just
  // refused it. The bid box is the panel directly below this one.
  if (mono.auction) {
    append(bar, [
      el("span", { class: "act-say" }, [
        el("span", { text: `🔨 ${VI.auction} — ${mono.spaces[mono.auction.space].name}` }),
        el("small", {
          class: "muted",
          text: mono.auction.activeIds.includes(state.you.id)
            ? "Trả giá ngay dưới đây, hoặc rút khỏi phiên."
            : "Bạn đã rút — chờ phiên kết thúc.",
        }),
      ]),
      state.you.isHost ? hostEndButton(ctx) : null,
    ]);
    return bar;
  }

  if (!mine) {
    const waiting = nameOf(state, pending.playerId);
    const seat = state.players.find((p) => p.id === pending.playerId);
    append(bar, [
      el("span", { class: "act-say", text: `⏳ Đang chờ ${waiting}…` }),
      // Only offered when they are actually gone, and the server checks that too
      // — a host who could skip a live opponent could skip them out of the game.
      state.you.isHost && seat && !seat.connected ? button("⏭️", VI.skipTurn, { a: "skip" }) : null,
      mono.restart ? null : restartButton(ctx),
      state.you.isHost ? hostEndButton(ctx) : null,
    ]);
    return bar;
  }

  switch (pending.kind) {
    case "roll":
      append(bar, [
        button("🎲", mono.doubles > 0 ? VI.rollAgain : VI.roll, { a: "roll" }, { primary: true }),
      ]);
      break;

    case "jail":
      append(bar, [
        el("span", { class: "act-say", text: `🚔 ${VI.inJail} (${pending.turns}/3)` }),
        button(
          "💸",
          `${VI.payBail} ${money(mono, pending.bail)}`,
          { a: "jail", how: "pay" },
          { primary: true },
        ),
        pending.cards > 0 ? button("🎫", VI.useCard, { a: "jail", how: "card" }) : null,
        button("🎲", VI.rollForDouble, { a: "roll" }),
      ]);
      break;

    case "buy": {
      const space = mono.spaces[pending.space];
      const mineSeat = seatOf(mono, state.you.id);
      const affordable = (mineSeat?.cash ?? 0) >= pending.price;
      append(bar, [
        el("span", { class: "act-say", text: `${space.icon} ${space.name}` }),
        button(
          "🤝",
          `${VI.buy} ${money(mono, pending.price)}`,
          { a: "buy" },
          {
            primary: true,
            disabled: !affordable,
            title: affordable ? "" : "Không đủ tiền mặt",
          },
        ),
        button("🙅", mono.rules.auction ? VI.toAuction : VI.skip, { a: "decline" }),
      ]);
      break;
    }

    // The rule this exists for: a street whose colour group you have not
    // completed can be built on *only* at the moment you are standing on it, so
    // the board asks then. Answering is the permission — walk on and the street
    // is unbuildable again until the next time you come home to it.
    case "upgrade": {
      const space = mono.spaces[pending.space];
      const mineSeat = seatOf(mono, state.you.id);
      const affordable = (mineSeat?.cash ?? 0) >= (pending.buildCost ?? 0);
      const what = pending.level > MAX_HOUSES
        ? `${VI.hotel} 🏨`
        : `${VI.houses} thứ ${pending.level} 🏠`;
      append(bar, [
        el("span", { class: "act-say" }, [
          el("span", { text: `🏠 ${space.icon} ${space.name} — nhà mình` }),
          el("small", { class: "muted", text: `Xây ${what}?` }),
        ]),
        button(
          "🏗️",
          `${VI.buildNow}: ${what} — ${money(mono, pending.buildCost ?? 0)}`,
          { a: "build", space: pending.space },
          {
            primary: true,
            disabled: !affordable,
            title: affordable ? "" : "Không đủ tiền mặt",
          },
        ),
        button("👉", VI.buildLater, { a: "later" }),
      ]);
      break;
    }

    case "tax":
      append(bar, [
        el("span", { class: "act-say", text: "🧾 Chọn cách trả thuế" }),
        button(
          "💵",
          `${VI.payFlat} ${money(mono, pending.flat)}`,
          { a: "tax", how: "flat" },
          { primary: pending.flat <= pending.percentAmount },
        ),
        button(
          "📊",
          `${VI.payPercent} — ${money(mono, pending.percentAmount)}`,
          { a: "tax", how: "percent" },
          { primary: pending.percentAmount < pending.flat },
        ),
      ]);
      break;

    case "debt":
      append(bar, [
        el("span", { class: "act-say danger-text" }, [
          el("span", { text: `🚨 Bạn nợ ${money(mono, pending.amount)}` }),
          el("small", {
            class: "muted",
            text: pending.toId
              ? ` cho ${nameOf(state, pending.toId)} — bán nhà hoặc thế chấp bên dưới`
              : " cho ngân hàng — bán nhà hoặc thế chấp bên dưới",
          }),
        ]),
        button("🏳️", VI.bankrupt, { a: "bankrupt" }, {
          danger: true,
          title: "Chỉ được khi thật sự không còn gì để bán",
        }),
      ]);
      break;

    case "end":
      append(bar, [
        button("➡️", VI.endTurn, { a: "endTurn" }, { primary: true }),
        // The turn only stops here at all when there was something worth
        // stopping for, so this says what that something is rather than the old
        // general note about what you *could* do.
        el("span", {
          class: "muted tiny-text",
          text: "Còn việc để làm: xây, giải chấp, hoặc trả lời đề nghị đổi chác.",
        }),
      ]);
      break;
  }

  if (!mono.restart) append(bar, [restartButton(ctx)]);
  if (state.you.isHost) append(bar, [hostEndButton(ctx)]);
  return bar;
}

/**
 * "Can we start again?"
 *
 * Open to anybody, players and watchers alike, because the person most likely to
 * want a fresh board is the one who walked in twenty minutes after it was dealt.
 * It only ever asks — the table decides.
 */
function restartButton(ctx) {
  return el("button", {
    class: "ghost tiny",
    title: "Cả bàn đồng ý thì chia bàn mới — người đang xem cũng được chia",
    text: `🔁 ${VI.askRestart}`,
    onClick: () => ctx.actions.monoRestart(),
  });
}

function hostEndButton(ctx) {
  return el("button", {
    class: "ghost tiny",
    title: "Ai nhiều tài sản nhất thì thắng",
    text: `⏹️ ${VI.callTime}`,
    onClick: () => ctx.actions.endMatch(),
  });
}

// --- your deeds ------------------------------------------------------------

/**
 * Everything you own, grouped, with the four things you can do to it.
 *
 * Present during a debt as well as on your own turn, because a debt is exactly
 * when somebody needs to sell a hotel, and a panel that hid itself then would
 * force the player into a bankruptcy they could have avoided.
 */
function estatePanel(ctx, mono) {
  const { state, local, actions } = ctx;
  const mineSeat = seatOf(mono, state.you.id);
  const owned = mono.spaces.filter((s) => s.ownerId === state.you.id);

  const body = [];
  if (!owned.length) {
    body.push(el("div", { class: "muted tiny-text", text: VI.nothingOwned }));
  } else {
    for (const bucket of bucketDeeds(mono, owned)) {
      body.push(
        el("div", { class: "deed-group", style: `--band:${bucket.color}` }, [
          el("div", { class: "dg-head" }, [
            el("span", { class: "dg-swatch", "aria-hidden": "true" }),
            el("span", { class: "dg-name", text: `${bucket.icon} ${bucket.name}` }),
            el("span", {
              class: bucket.complete ? "dg-count whole" : "dg-count",
              title: bucket.complete ? VI.wholeGroup : "chưa đủ nhóm",
              text: bucket.total ? `${bucket.spaces.length}/${bucket.total}` : "",
            }),
          ]),
          ...bucket.spaces.map((space) => deedRow(ctx, mono, space, mineSeat, bucket)),
        ]),
      );
    }
  }

  return el("div", { class: "panel mono-panel estate" }, [
    el("header", {}, [
      el("span", { text: `🏘️ ${VI.myEstate}` }),
      el("span", { class: "spacer" }),
      el("span", { class: "tiny-text muted", text: `${owned.length} ô` }),
    ]),
    el("div", { class: "panel-body tight" }, body),
  ]);

  /** One deed, with its colour down the left and its four buttons on the right. */
  function deedRow(ctx2, mono2, space, seat, bucket) {
    const canSell = space.kind === "place" && (space.level ?? 0) > 0;
    const unmortgageCost = Math.ceil((Math.floor(space.price / 2) * 110) / 100);
    return el("div", {
      class: `deed${local.monoSelected === space.i ? " picked" : ""}${
        space.mortgaged ? " hocked" : ""
      }`,
      style: `--band:${bucket.color}`,
    }, [
      el("button", {
        type: "button",
        class: "deed-open",
        title: "Xem ô này trên bàn",
        onClick: () => {
          local.monoSelected = space.i;
          updateMonoRoom(ctx2);
        },
      }, [
        el("span", { class: "deed-icon", "aria-hidden": "true", text: space.icon }),
        el("div", { class: "deed-name" }, [
          el("strong", { text: space.name }),
          el("small", { class: "muted" }, [
            el("span", {
              text: space.mortgaged
                ? `📄 ${VI.mortgaged}`
                : space.rent !== undefined
                ? `💰 ${money(mono2, space.rent)}`
                : "—",
            }),
            space.level ? el("span", { text: ` · ${buildingGlyphs(space.level)}` }) : null,
            // 🔓 only, and only when it is true. A street you cannot build on
            // from here is the normal case now, and marking every one of them
            // would be marking the whole panel.
            space.canBuild ? el("span", { class: "unlocked", text: " · 🔓" }) : null,
          ]),
        ]),
      ]),
      el("div", { class: "deed-acts" }, [
        space.kind === "place"
          ? el("button", {
            class: "tiny",
            disabled: !space.canBuild,
            title: space.canBuild
              ? `${VI.build} — ${money(mono2, space.houseCost ?? 0)}`
              : space.buildNote ?? VI.build,
            text: "🏗️",
            onClick: () => actions.mono({ a: "build", space: space.i }),
          })
          : null,
        space.kind === "place"
          ? el("button", {
            class: "tiny",
            disabled: !canSell,
            title: `${VI.sell} — ${money(mono2, Math.floor((space.houseCost ?? 0) / 2))}`,
            text: "🧰",
            onClick: () => actions.mono({ a: "sell", space: space.i }),
          })
          : null,
        space.mortgaged
          ? el("button", {
            class: "tiny",
            disabled: (seat?.cash ?? 0) < unmortgageCost,
            title: `${VI.unmortgage} — ${money(mono2, unmortgageCost)}`,
            text: "🧾",
            onClick: () => actions.mono({ a: "unmortgage", space: space.i }),
          })
          : el("button", {
            class: "tiny",
            title: `${VI.mortgage} — ${money(mono2, Math.floor(space.price / 2))}`,
            text: "📄",
            onClick: () => actions.mono({ a: "mortgage", space: space.i }),
          }),
      ]),
    ]);
  }
}

/**
 * Your deeds, sorted into the groups the rules care about.
 *
 * A flat list of eight streets in board order tells you nothing about the thing
 * that decides whether you can build — which colours you have and how close each
 * one is to complete. So each bucket carries its group's own colour, and says how
 * much of the group you hold.
 */
function bucketDeeds(mono, owned) {
  const buckets = new Map();
  const at = (key, name, icon, color, total) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, name, icon, color, total, spaces: [], complete: false };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const space of owned) {
    if (space.kind === "place") {
      const group = groupOf(mono, space);
      const total = mono.spaces.filter((s) => s.group === space.group).length;
      at(
        space.group,
        group?.name ?? "Nhóm",
        group?.icon || "🎨",
        group?.color ?? "var(--border)",
        total,
      ).spaces.push(space);
    } else if (space.kind === "transport") {
      at("transport", "Bến — nhà xe", "🚉", "var(--text-dim)", 4).spaces.push(space);
    } else {
      at("utility", "Điện — nước", "💡", "var(--text-dim)", 2).spaces.push(space);
    }
  }

  for (const bucket of buckets.values()) bucket.complete = bucket.spaces.length >= bucket.total;
  // Whole groups first: they are the ones you can build on without a second
  // thought, which is the reason to look at this panel at all.
  return [...buckets.values()].sort((a, b) =>
    Number(b.complete) - Number(a.complete) || a.spaces[0].i - b.spaces[0].i
  );
}

// --- the rules, at the table -----------------------------------------------

/** One row of the little icon / text / value list both the panel and the book use. */
function briefRows(list) {
  return el(
    "div",
    { class: "rule-brief" },
    list.map(([icon, text, value]) =>
      el("div", { class: "rule-brief-row" }, [
        el("span", { "aria-hidden": "true", text: icon }),
        el("span", { text }),
        value ? el("span", { class: "rule-value", text: value }) : null,
      ])
    ),
  );
}

/** What this particular table is playing for: its money and its house rules. */
function tableTerms(mono) {
  const m = mono.map.money;
  const on = (yes) => (yes ? VI.ruleOn : VI.ruleOff);
  return [
    ["💵", VI.startCash, money(mono, m.start)],
    ["🏁", VI.salary, money(mono, m.go)],
    ["🚔", VI.bail, money(mono, m.bail)],
    ...Object.entries(VI.rules).map(([key, info]) => {
      // The pot is worth naming when it is switched on and has money in it: it
      // is the one house rule that changes what a square is worth mid-game.
      const extra = key === "parkingPot" && mono.pot ? ` · ${money(mono, mono.pot)}` : "";
      return [info.icon, info.label, on(mono.rules[key]) + extra];
    }),
  ];
}

/** Where things are. Rules tell you what may happen; this tells you where to click. */
const SCREEN_GUIDE = [
  ["👆", "Bấm vào một ô để xem giá, tiền thuê, chủ và ảnh của nơi đó."],
  ["🎲", "Xúc xắc, tiền mặt và tổng tài sản nằm ở thanh trên bàn cờ."],
  ["🎯", "Việc cần làm luôn hiện ngay dưới bàn cờ — tung, mua, trả tiền, kết thúc lượt."],
  ["🏘️", "Tài sản của tôi: xây 🏠, bán 🏚️, thế chấp 📄 và giải chấp."],
  ["🤝", "Đổi chác: gửi đề nghị tiền hoặc ô cho người khác, họ nhận hoặc từ chối."],
  ["🔨", "Khi có đấu giá, ô trả giá hiện ở giữa bàn cờ cho tất cả mọi người."],
  ["📖", `Nút ${VI.rulebookShort} ở thanh trên cùng mở lại trang này bất cứ lúc nào.`],
];

/**
 * The terms of this table, on the board rather than only on the setup page.
 *
 * Somebody who joined by link never saw the setup page, so this is where they
 * find out what the host switched on. Short on purpose: the rules themselves are
 * long, and they live in the rulebook a button away rather than in a sidebar
 * column two hundred pixels wide.
 *
 * Folded, because it is reference rather than play — but the summary line
 * carries this table's terms, so the closed state still answers the question
 * that gets asked most: what are we playing for.
 */
function helpPanel(ctx, mono) {
  const { local, actions } = ctx;
  const m = mono.map.money;
  const on = (yes) => (yes ? VI.ruleOn : VI.ruleOff);

  return el("details", {
    class: "panel mono-panel mono-help",
    open: local.monoHelpOpen === true,
    onToggle: (e) => (local.monoHelpOpen = e.target.open),
  }, [
    el("summary", {}, [
      el("span", { text: `📖 ${VI.help}` }),
      el("small", {
        class: "muted",
        text: `${money(mono, m.start)} · ${VI.salary.toLocaleLowerCase("vi")} ${
          money(mono, m.go)
        } · ${VI.rules.auction.label.toLocaleLowerCase("vi")}: ${on(mono.rules.auction)}`,
      }),
    ]),
    el("div", { class: "panel-body" }, [
      el("h4", { class: "help-head", text: VI.thisTable }),
      briefRows(tableTerms(mono)),
      el("button", {
        class: "primary rule-open",
        type: "button",
        text: `📖 ${VI.openRules}`,
        onClick: () => actions.openMonoRules(),
      }),
      el("h4", { class: "help-head", text: VI.onScreen }),
      briefRows(SCREEN_GUIDE),
    ]),
  ]);
}

/**
 * The rulebook, over the board.
 *
 * A modal and not a panel because it is long: a dozen sections read badly in a
 * sidebar, and rules are looked up in one go and then put down again. Reachable
 * from the top bar on every screen including the lobby, because the moment
 * somebody wants the rules is usually before their first turn, not after it.
 *
 * In the lobby there is no game yet, so the money shown is the standard table's.
 * Every built-in board uses those figures, and a board that overrides them says
 * so in this same panel as soon as play begins.
 */
function rulebookTable(ctx) {
  const mono = ctx.state?.mono;
  if (mono) return mono;
  const config = ctx.state?.config ?? {};
  return {
    map: { money: DEFAULT_MONEY },
    rules: Object.fromEntries(
      Object.keys(VI.rules).map((key) => [key, Boolean(config[configKeyFor(key)])]),
    ),
    pot: 0,
  };
}

function rulebookDialog(ctx) {
  const mono = rulebookTable(ctx);
  const close = () => ctx.actions.closeMonoRules();
  return el("div", { class: "modal-wrap" }, [
    el("div", { class: "j-backdrop", onClick: close }),
    el("div", { class: "modal panel wide mono-book", role: "dialog", "aria-label": VI.help }, [
      el("header", {}, [
        el("span", { text: `📖 ${VI.help}` }),
        el("span", { class: "spacer" }),
        el("button", { class: "ghost tiny", title: "Đóng (Esc)", text: "✕", onClick: close }),
      ]),
      el("div", { class: "modal-body" }, [
        el("div", { class: "book-cols" }, [
          el("div", { class: "book-side" }, [
            el("h4", { class: "help-head", text: VI.thisTable }),
            briefRows(tableTerms(mono)),
            el("h4", { class: "help-head", text: VI.onScreen }),
            briefRows(SCREEN_GUIDE),
          ]),
          el("div", { class: "book-main" }, [
            el("h4", { class: "help-head", text: VI.theRules }),
            rulesFull(mono),
          ]),
        ]),
      ]),
    ]),
  ]);
}

/**
 * Whether the rulebook is currently mounted.
 *
 * Kept here rather than read off the DOM because the point of it is to mount the
 * book once. The board sends a snapshot every time anybody does anything, and
 * rebuilding the dialog under somebody who is halfway through the rules would
 * throw away their place in it on another player's dice roll.
 */
let bookMounted = false;

/** Mount or clear the rulebook. Its own layer, so `updateDialogs` cannot wipe it. */
function updateRulebook(ctx) {
  const layer = $("monoRulesLayer");
  if (!layer) return;
  const want = Boolean(ctx.local.monoRulesOpen);
  if (want === bookMounted) return;
  bookMounted = want;
  fill(layer, want ? [rulebookDialog(ctx)] : []);
  if (!want) return;
  const body = layer.querySelector(".modal-body");
  if (body) body.scrollTop = 0;
}

// --- auction ---------------------------------------------------------------

function auctionPanel(ctx, mono) {
  const { state, local, actions } = ctx;
  const auction = mono.auction;
  const space = mono.spaces[auction.space];
  const inIt = auction.activeIds.includes(state.you.id);
  const mineSeat = seatOf(mono, state.you.id);
  const minimum = auction.high + 1;

  const input = el("input", {
    id: "monoBidInput",
    type: "number",
    min: minimum,
    max: mineSeat?.cash ?? 0,
    step: 1,
    value: local.monoBid ?? String(minimum),
    disabled: !inIt,
    onInput: (e) => (local.monoBid = e.target.value),
  });

  return el("div", { class: "auction top" }, [
    el("div", { class: "auction-head" }, [
      el("span", { "aria-hidden": "true", text: "🔨" }),
      el("strong", { text: `${VI.auction}: ${space.icon} ${space.name}` }),
      // An auction runs on the same fuse as anything else the board waits for,
      // and it waits on every bidder at once — so the countdown lives here
      // rather than in the turn strip, which is only ever about one person.
      mono.autoAt
        ? el("span", {
          class: "turn-clock",
          title: `Chưa trả lời thì bàn rút giúp — ${AUTO_IDLE_MS / 1000} giây`,
        }, [
          el("span", { "aria-hidden": "true", text: "⏳" }),
          el("span", { class: "clock-num", "data-until": String(mono.autoAt), text: "…" }),
        ])
        : null,
    ]),
    el("div", { class: "auction-high" }, [
      el("span", {
        text: auction.highId
          ? `${VI.highest}: ${money(mono, auction.high)} — ${nameOf(state, auction.highId)}`
          : VI.noBid,
      }),
      el("small", {
        class: "muted",
        text: ` · còn ${auction.activeIds.length} người`,
      }),
    ]),
    inIt
      ? el("div", { class: "auction-form" }, [
        input,
        el("button", {
          class: "primary",
          text: `🔨 ${VI.bid}`,
          onClick: () => {
            actions.mono({ a: "bid", amount: Number(input.value) });
            local.monoBid = null;
          },
        }),
        el("button", {
          text: `🚪 ${VI.withdraw}`,
          onClick: () => actions.mono({ a: "withdraw" }),
        }),
      ])
      : el("div", {
        class: "muted tiny-text",
        text: state.you.spectator
          ? "Bạn đang xem — không trả giá được."
          : "Bạn đã rút khỏi phiên này.",
      }),
  ]);
}

// --- trading ---------------------------------------------------------------

function tradePanel(ctx, mono) {
  const { state, local, actions } = ctx;
  const others = mono.players.filter((p) => !p.bankrupt && p.id !== state.you.id);
  const draft = local.monoTrade ??
    { toId: others[0]?.id ?? null, give: [], want: [], giveCash: "", wantCash: "" };
  local.monoTrade = draft;
  if (!others.some((p) => p.id === draft.toId)) draft.toId = others[0]?.id ?? null;

  const mineDeeds = mono.spaces.filter((s) => s.ownerId === state.you.id && !s.level);
  const theirDeeds = draft.toId
    ? mono.spaces.filter((s) => s.ownerId === draft.toId && !s.level)
    : [];

  const tick = (space, list) =>
    el("label", { class: "trade-tick" }, [
      el("input", {
        type: "checkbox",
        checked: list.includes(space.i),
        onChange: (e) => {
          if (e.target.checked) list.push(space.i);
          else list.splice(list.indexOf(space.i), 1);
        },
      }),
      el("span", { "aria-hidden": "true", text: space.icon }),
      el("span", { text: space.name }),
    ]);

  const incoming = mono.trades.filter((t) => t.toId === state.you.id);
  const outgoing = mono.trades.filter((t) => t.fromId === state.you.id);

  const body = [];

  for (const offer of incoming) {
    body.push(
      el("div", { class: "offer" }, [
        el("strong", { text: `🤝 ${nameOf(state, offer.fromId)} đề nghị:` }),
        offerSummary(mono, offer, true),
        el("div", { class: "row", style: "gap:8px" }, [
          el("button", {
            class: "primary tiny",
            text: `✅ ${VI.accept}`,
            onClick: () => actions.mono({ a: "respond", tradeId: offer.id, accept: true }),
          }),
          el("button", {
            class: "tiny",
            text: `🙅 ${VI.decline}`,
            onClick: () => actions.mono({ a: "respond", tradeId: offer.id, accept: false }),
          }),
        ]),
      ]),
    );
  }

  for (const offer of outgoing) {
    body.push(
      el("div", { class: "offer sent" }, [
        el("strong", { text: `📤 Đã gửi ${nameOf(state, offer.toId)}` }),
        offerSummary(mono, offer, false),
      ]),
    );
  }

  if (!others.length) {
    body.push(el("div", { class: "muted tiny-text", text: "Không còn ai để đổi chác." }));
  } else {
    body.push(
      el("div", { class: "field" }, [
        el("label", { text: `👤 ${VI.tradeWith}` }),
        el(
          "select",
          {
            onChange: (e) => {
              draft.toId = e.target.value;
              draft.want = [];
              updateMonoRoom(ctx);
            },
          },
          others.map((p) =>
            el("option", {
              value: p.id,
              selected: draft.toId === p.id,
              text: `${p.token} ${nameOf(state, p.id)}`,
            })
          ),
        ),
      ]),
      el("div", { class: "trade-cols" }, [
        el("div", {}, [
          el("strong", { class: "tiny-text", text: `📤 ${VI.youGive}` }),
          ...mineDeeds.map((s) => tick(s, draft.give)),
          el("input", {
            id: "monoGiveCash",
            type: "number",
            min: 0,
            placeholder: "tiền",
            value: draft.giveCash,
            onInput: (e) => (draft.giveCash = e.target.value),
          }),
        ]),
        el("div", {}, [
          el("strong", { class: "tiny-text", text: `📥 ${VI.youWant}` }),
          ...theirDeeds.map((s) => tick(s, draft.want)),
          el("input", {
            id: "monoWantCash",
            type: "number",
            min: 0,
            placeholder: "tiền",
            value: draft.wantCash,
            onInput: (e) => (draft.wantCash = e.target.value),
          }),
        ]),
      ]),
      el("button", {
        style: "width:100%",
        disabled: !draft.toId,
        text: `🤝 ${VI.sendOffer}`,
        onClick: () => {
          actions.mono({
            a: "propose",
            toId: draft.toId,
            giveSpaces: [...draft.give],
            giveCash: Number(draft.giveCash) || 0,
            wantSpaces: [...draft.want],
            wantCash: Number(draft.wantCash) || 0,
          });
          local.monoTrade = null;
        },
      }),
      el("small", {
        class: "muted tiny-text",
        text: "Ô còn nhà không đổi được — bán hết công trình trước.",
      }),
    );
  }

  return el("div", { class: "panel mono-panel" }, [
    el("header", { text: `🤝 ${VI.trade}` }),
    el("div", { class: "panel-body tight" }, body),
  ]);
}

function offerSummary(mono, offer, incoming) {
  const name = (list) =>
    list.map((i) => `${mono.spaces[i].icon} ${mono.spaces[i].name}`).join(", ") || "—";
  // From the reader's side, not the proposer's: "you give" has to mean what the
  // person looking at it gives away, or an offer reads backwards to half the table.
  const theyGive = incoming ? offer.giveSpaces : offer.wantSpaces;
  const theyGiveCash = incoming ? offer.giveCash : offer.wantCash;
  const youGive = incoming ? offer.wantSpaces : offer.giveSpaces;
  const youGiveCash = incoming ? offer.wantCash : offer.giveCash;
  return el("div", { class: "offer-rows" }, [
    el("div", {
      text: `📥 Bạn nhận: ${name(theyGive)}${
        theyGiveCash ? ` + ${money(mono, theyGiveCash)}` : ""
      }`,
    }),
    el("div", {
      text: `📤 Bạn đưa: ${name(youGive)}${youGiveCash ? ` + ${money(mono, youGiveCash)}` : ""}`,
    }),
  ]);
}
