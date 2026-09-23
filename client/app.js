// Client bootstrap: identity, socket lifecycle, and render dispatch.

import { $, el, fill } from "./dom.js";
import { buildLanding, buildRoom, updateLanding, updateRoom, updateTimer } from "./views.js";
import {
  buildGameGate,
  buildMonoLanding,
  buildMonoRoom,
  updateMonoLanding,
  updateMonoRoom,
} from "./monopoly.js";
import { handleAssistReply, mountAssistant, setAssistantAvailable } from "./assistant.js";
import { receiveBuzz } from "./buzz.js";
import { receiveReaction } from "./throwables.js";
import { speak } from "./speech.js";
import { receiveMention } from "./mention.js";
// Imported for its side effect too: theme.js applies the stored personal look
// before anything renders, so there is no flash of the default palette.
import { updatePrefs } from "./theme.js";
import {
  DEFAULT_CONFIG,
  EXTRA_HINT_PROMPT,
  GAME_KEYS,
  gameOf,
  GAMES,
  isSoloMode,
  LIMITS,
  REACTIONS,
} from "/shared/constants.js";
import { builtinMap, DEFAULT_MAP_ID } from "/shared/monopoly_maps.js";
import { EMOJI_RECENT_LIMIT } from "/shared/emoji.js";
import { CURRENT_RELEASE } from "/shared/changelog.js";

const STORE = {
  playerId: "closeword.playerId",
  nickname: "closeword.nickname",
  room: "closeword.room",
  /** Recently used emoji, newest first. This browser only. */
  emoji: "closeword.emoji",
  /** Highest release version whose notes have been read in this browser. */
  seenRelease: "closeword.seenRelease",
  /**
   * Which of the two games this browser last chose.
   *
   * Remembered so the chooser is the first screen once rather than every time:
   * somebody who came here for the board game should land on the board game's
   * setup page. The back button on that page clears it.
   */
  game: "closeword.game",
  /**
   * Solo practice records, keyed by word set and difficulty.
   *
   * The one thing in the app that is *meant* to outlive a room, and it still
   * never leaves this browser: a practice best is nobody else's business, there
   * is no leaderboard to join, and the server is deliberately given no way to
   * store it. Same rule as your name and your look.
   */
  records: "closeword.practice",
  /**
   * Flat board or 3D board, for the person sitting at this browser.
   *
   * Their choice and nobody else's: two people at the same table can be looking
   * at the same game from different sides of the same decision, because it
   * changes nothing about the game. Remembered because somebody who switched
   * back to the flat board did not mean "just this once".
   */
  boardView: "closeword.boardView",
};

/** Server-authoritative room snapshot; null when we are not in a room. */
let state = null;

const local = {
  connection: "connecting",
  nickname: readStore(STORE.nickname) ?? "",
  pendingCode: roomFromPath() ?? "",
  /** Room we should (re)join on connect. */
  roomCode: null,
  newConfig: { ...DEFAULT_CONFIG },
  sort: "rank",
  clockOffset: 0,
  serverInfo: null,
  /**
   * True once /api/info has failed. Distinct from `serverInfo === null`, which
   * is also what "the request is still in flight" looks like — without it the
   * landing page says "checking…" forever at a server that will never answer.
   */
  serverInfoFailed: false,
  /** Set by buildLanding so updateLanding can redraw the picker once /api/info lands. */
  renderSources: null,
  autofocus: false,
  copied: false,
  /**
   * `{ playerId, data, mine, error }` while the journey drawer is open. `mine`
   * is your own journey, fetched alongside somebody else's so the drawer can
   * show the two runs side by side.
   */
  journey: null,
  /** People asking to watch your round, oldest first. Answered one at a time. */
  journeyAsks: [],
  /** An invitation waiting on a yes or no, or null. */
  invite: null,
  /**
   * `{ fromId, fromNickname, at }` while somebody is building a room with you in
   * mind, before it exists. Held rather than shown as a one-off toast because the
   * whole complaint it answers is "I sat there and nothing happened" — a notice
   * you can look away from and still find is the point.
   */
  inviteAhead: null,
  /** `{ people }` while the invite picker is open, else null. */
  invitePicker: null,
  /**
   * Who has been lined up to invite. Deliberately outside `invitePicker`: on the
   * landing page the picker is a dialog you close before creating the room, and
   * a list that empties when you close the window you built it in is a trap.
   */
  inviteQueue: new Set(),
  /** Emoji palette open, and what this browser has reached for lately. */
  emojiOpen: false,
  emojiRecent: readEmojiRecent(),
  /** The board game's rulebook, open over the board. */
  monoRulesOpen: false,
  /**
   * Which board this browser draws: "3d", "2d", or "auto" for neither chosen.
   *
   * "auto" is not a third board, it is the absence of a decision — and it
   * resolves by screen size, because on a phone the 3D board's street names are
   * too small to read and the flat grid is the better game. Once somebody presses
   * the button their choice is stored and the size stops mattering. Stored as a
   * string rather than a boolean so a third kind of board later is a value and
   * not a migration.
   */
  monoView: ["2d", "3d"].includes(readStore(STORE.boardView) ?? "")
    ? readStore(STORE.boardView)
    : "auto",
  /** Release notes panel, and the newest release read in this browser. */
  changelogOpen: false,
  seenRelease: Number(readStore(STORE.seenRelease) ?? 0),
  actions: null,
  guessInput: null,
  /** Set when a deep link should join automatically once we are connected. */
  autoJoin: Boolean(roomFromPath()) && Boolean(readStore(STORE.nickname)),
  /**
   * Your practice record for the room you are in, or null outside solo. Mirrored
   * into `local` so the view can read it without touching localStorage on every
   * render — the store is the truth, this is the copy on screen.
   */
  record: null,
  /** Practice rounds already folded into the record, so a resend cannot double-count. */
  countedRounds: new Set(),
  /**
   * `{ online, playing, rooms }` for the landing page, or null before the first
   * reply. Polled rather than pushed: it is only ever looked at by somebody who
   * is *not* in a room, so there is no snapshot to carry it, and a poll nobody is
   * watching costs one small message every few seconds.
   */
  liveRooms: null,
  /**
   * The word whose detail panel is open on the board, or null.
   *
   * Held here rather than in the DOM because the board is rebuilt wholesale on
   * every snapshot, and a panel that closed itself whenever anybody else guessed
   * would be unusable in a busy room.
   */
  openWord: null,
  /**
   * word -> `{ status, note }` for everything looked up this session.
   *
   * A cache in front of the server's cache, so reopening a panel is instant and
   * costs no message. Keyed by word only: a definition is a fact about English,
   * not about the round, so it stays valid across rounds and rooms. Dropped
   * entirely on reload — this is convenience, not storage.
   */
  words: new Map(),

  // --- the board game -----------------------------------------------------
  /**
   * "closeword", "monopoly", or null for the chooser.
   *
   * Only ever decides which *setup page* to show. Inside a room the game is
   * whatever the room says it is, because the room was created by somebody else
   * and their choice is the one that counts.
   */
  game: GAME_KEYS.includes(readStore(STORE.game)) ? readStore(STORE.game) : null,
  /** Square whose deed card is open in the middle of the board. */
  monoSelected: null,
  /** The bid box's contents, so a snapshot mid-auction does not wipe it. */
  monoBid: null,
  /** The half-written trade offer: `{ toId, give, want, giveCash, wantCash }`. */
  monoTrade: null,
  /** Pasted or read-from-file map JSON, before it has been sent. */
  monoMapDraft: "",
  /** The server's verdict on the last map sent: `{ ok, name, errors }`. */
  monoMapResult: null,
};

const playerId = ensurePlayerId();
let socket = null;
let reconnectDelay = 500;
let mountedScreen = null;
/** Ids ticked before the room existed, invited as soon as it does. */
let pendingInvites = [];

/** How long "somebody is building a room for you" stays on screen. */
const INVITE_AHEAD_TTL_MS = 3 * 60_000;

/** Must match CLOSE_SUPERSEDED in server/main.ts. */
const CLOSE_SUPERSEDED = 4001;

// ---------------------------------------------------------------------------
// Storage and identity
// ---------------------------------------------------------------------------

function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private browsing: identity just won't survive a reload.
  }
}

/**
 * Practice records: one entry per word set and difficulty.
 *
 * Shaped as { best, solved, played } — fewest guesses to the word, how many
 * words you have found, how many you have seen. Read and written whole because
 * it is a handful of integers, and wrapped in try/catch because a corrupted or
 * unavailable localStorage must cost you a scoreboard, not the game.
 */
function recordKey(config) {
  return `${config.wordSource}:${config.difficulty}`;
}

function readRecords() {
  try {
    const raw = JSON.parse(readStore(STORE.records) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function recordFor(config) {
  const entry = readRecords()[recordKey(config)];
  if (!entry || typeof entry !== "object") return { best: null, solved: 0, played: 0 };
  return {
    best: Number.isFinite(entry.best) ? entry.best : null,
    solved: Number.isFinite(entry.solved) ? entry.solved : 0,
    played: Number.isFinite(entry.played) ? entry.played : 0,
  };
}

/**
 * Fold one finished practice round into the record.
 *
 * Counts the round whether or not it was solved — a word you gave up on is
 * still a word you practised — and only lets `best` move when you actually
 * found it.
 */
function notePracticeRound({ config, solved, guesses }) {
  const records = readRecords();
  const key = recordKey(config);
  const before = recordFor(config);
  const next = {
    best: solved ? (before.best === null ? guesses : Math.min(before.best, guesses)) : before.best,
    solved: before.solved + (solved ? 1 : 0),
    played: before.played + 1,
  };
  records[key] = next;
  writeStore(STORE.records, JSON.stringify(records));
  return next;
}

/**
 * 128 bits of randomness as hex.
 *
 * Deliberately NOT crypto.randomUUID(): that is restricted to secure contexts,
 * and the whole point of this app is teammates opening http://10.x.x.x:8791 on
 * the office network, which is not one. It threw before the first render, so the
 * page never got past "Connecting…". crypto.getRandomValues has no such
 * restriction; Math.random is the last resort for an ancient browser, and a
 * duplicate player id would only ever collide with another tab of the same
 * person, which the supersede path already handles.
 */
function randomToken() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function ensurePlayerId() {
  const existing = readStore(STORE.playerId);
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  const fresh = randomToken();
  writeStore(STORE.playerId, fresh);
  return fresh;
}

/**
 * Recently used emoji, kept per browser and never sent anywhere.
 *
 * Stored as a plain string of emoji separated by spaces rather than JSON: it is
 * a list of characters, and a parse failure on somebody's chat history should
 * cost them their recents, not the page.
 */
function readEmojiRecent() {
  const raw = readStore(STORE.emoji);
  if (!raw) return [];
  return raw.split(" ").filter(Boolean).slice(0, EMOJI_RECENT_LIMIT);
}

function rememberEmoji(emoji) {
  const next = [emoji, ...local.emojiRecent.filter((e) => e !== emoji)]
    .slice(0, EMOJI_RECENT_LIMIT);
  local.emojiRecent = next;
  writeStore(STORE.emoji, next.join(" "));
}

function roomFromPath() {
  const match = location.pathname.match(/^\/r\/([A-Za-z0-9]{1,12})\/?$/);
  return match ? match[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(text, level = "info") {
  const node = el("div", { class: `toast ${level}`, text });
  $("toasts").appendChild(node);
  setTimeout(() => node.remove(), level === "error" ? 5000 : 3000);
}

/**
 * A persistent bar for states the player has to act on, rather than a toast that
 * disappears while they are reading it.
 */
function showConnBanner(text, actionLabel) {
  const bar = $("connBanner");
  if (!bar) return;
  bar.hidden = false;
  fill(bar, [
    el("span", { text }),
    actionLabel
      ? el("button", {
        class: "tiny",
        text: actionLabel,
        onClick: () => {
          hideConnBanner();
          reconnectDelay = 500;
          connect();
        },
      })
      : null,
  ]);
}

function hideConnBanner() {
  const bar = $("connBanner");
  if (bar) {
    bar.hidden = true;
    bar.replaceChildren();
  }
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  toast("Not connected yet — hold on.", "warn");
  return false;
}

/**
 * Tell the server what to call us, so other people can invite us.
 *
 * The name lives in this browser's localStorage; the server keeps a copy in the
 * open socket and nowhere else. Sent quietly — before a room exists there is no
 * connection banner to complain to, and a failure here costs nothing but being
 * uninvitable until the next connect.
 */
function announcePresence() {
  const name = local.nickname.trim();
  if (!name || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ t: "presence", nickname: name }));
}

/**
 * Ask what is open, but only when somebody is looking.
 *
 * Skipped while in a room: the list is a landing-page thing, and a poll running
 * behind a live game is pure waste on both ends.
 */
function askForRooms() {
  if (state) return;
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ t: "rooms" }));
}

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws?id=${encodeURIComponent(playerId)}`);
  local.connection = "connecting";
  render();

  socket.onopen = () => {
    local.connection = "online";
    reconnectDelay = 500;
    hideConnBanner();
    // Re-announce on every connect: the server holds the name in the socket, so
    // it is gone the moment one drops and has to be told again.
    announcePresence();
    askForRooms();
    // A reconnect must re-announce us; the server keys players by id, so this
    // restores our board and score rather than creating a new player.
    if (local.roomCode) {
      send({ t: "join", code: local.roomCode, nickname: local.nickname, playerId });
    } else if (local.autoJoin && local.pendingCode && local.nickname) {
      local.autoJoin = false;
      send({ t: "join", code: local.pendingCode, nickname: local.nickname, playerId });
    }
    render();
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  };

  socket.onclose = (event) => {
    // Deliberately displaced by another tab: stand down. Reconnecting here would
    // displace that tab, which would reconnect and displace us, forever.
    if (event.code === CLOSE_SUPERSEDED) {
      local.connection = "superseded";
      state = null;
      mountedScreen = null;
      render();
      showConnBanner(
        "CloseWord is open in another tab, which is now using this player. " +
          "Only one at a time.",
        "Play here instead",
      );
      return;
    }
    local.connection = "offline";
    render();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 2);
  };

  socket.onerror = () => {
    local.connection = "offline";
  };
}

/**
 * Whether an open drawer is showing fewer rows than the room says exist.
 *
 * Watching somebody else's live run is the one place the snapshot cannot keep
 * the drawer current: their guesses are on their board, not yours, so the only
 * source is another journey request. Comparing their public guess count with the
 * rows already in hand asks for exactly one refresh per guess they make, and
 * none at all once they stop — which is what makes it affordable.
 */
function watchedRunFellBehind() {
  if (state?.phase !== "playing" || !local.journey?.data) return false;
  const round = local.journey.data.rounds.find((r) => r.number === state.round?.number);
  if (!round || round.hidden) return false;
  const player = state.players.find((p) => p.id === local.journey.playerId);
  if (!player) return false;
  return player.guessCount > round.steps.filter((s) => !s.hint).length;
}

/**
 * Keep the practice record in step with the round that just ended.
 *
 * Driven off the snapshot rather than a "you solved it" event because the round
 * can end several ways — you found the word, you gave up and pressed next, the
 * host controls are yours alone — and all of them land here as a phase change.
 *
 * `countedRounds` makes it idempotent: snapshots are full and can be resent for
 * reasons that have nothing to do with the round (somebody's connection
 * flickers), and a record that creeps upwards on its own is worse than none.
 */
function notePractice(previous) {
  if (!state) return;
  if (!isSoloMode(state.config.mode)) {
    local.record = null;
    local.countedRounds.clear();
    return;
  }
  const finished = state.phase === "roundEnd" || state.phase === "matchEnd";
  const number = state.round?.number ?? 0;
  if (finished && number && !local.countedRounds.has(number)) {
    local.countedRounds.add(number);
    const you = state.players.find((p) => p.id === state.you.id);
    local.record = notePracticeRound({
      config: state.config,
      solved: Boolean(you?.solved),
      // Hint rows are not guesses anywhere else in the app, and a best measured
      // in "rows on the board" would quietly reward buying hints.
      guesses: you?.guessCount ?? 0,
    });
    return;
  }
  // A fresh room, or the first snapshot after joining one: show what this browser
  // already knows about this word set before any round has ended.
  if (
    !local.record || previous?.config?.wordSource !== state.config.wordSource ||
    previous?.config?.difficulty !== state.config.difficulty
  ) {
    local.record = recordFor(state.config);
  }
}

function handleServerMessage(msg) {
  switch (msg.t) {
    case "hello": {
      local.roomCode = msg.code;
      writeStore(STORE.room, msg.code);
      if (location.pathname !== `/r/${msg.code}`) {
        history.replaceState(null, "", `/r/${msg.code}`);
      }
      local.autofocus = true;
      local.invitePicker = null;
      // No toast here: the server sends one per invitation, naming the person, as
      // soon as each lands. Announcing the batch as well said the same thing
      // twice in two voices.
      for (const id of pendingInvites) send({ t: "invite", playerId: id });
      pendingInvites = [];
      local.inviteQueue.clear();
      return;
    }

    case "state": {
      const previous = state;
      state = msg.room;
      local.clockOffset = Date.now() - state.serverNow;
      notePractice(previous);
      // Joining by link is how most people arrive, and it can drop this browser
      // into either game without it ever having chosen. Remember what the room
      // turned out to be, so leaving it lands back on that game's setup page
      // rather than on the chooser.
      const game = gameOf(state.config.mode);
      if (local.game !== game) {
        local.game = game;
        writeStore(STORE.game, game);
      }
      // Entering a new round should put the cursor back in the guess box.
      if (previous?.phase !== "playing" && state.phase === "playing") local.autofocus = true;
      // A journey is a request/response, not part of the snapshot, so an open
      // drawer has to re-ask. Only when the round actually moved: re-asking on
      // every snapshot would send one request per guess in the room.
      if (
        local.journey &&
        (previous?.phase !== state.phase || previous?.round?.number !== state.round?.number ||
          watchedRunFellBehind())
      ) {
        send({ t: "journey", playerId: local.journey.playerId });
      }
      render();
      return;
    }

    case "journey": {
      if (!local.journey) return;
      // Two requests are in flight when viewing somebody else, so route the
      // reply by whose journey it is rather than by arrival order.
      if (msg.journey && msg.journey.playerId !== local.journey.playerId) {
        if (msg.journey.playerId === state?.you?.id) local.journey.mine = msg.journey;
        render();
        return;
      }
      local.journey.data = msg.journey ?? null;
      local.journey.error = msg.journey ? null : (msg.message ?? "Nothing to show.");
      render();
      return;
    }

    case "journeyAsk": {
      // Queued rather than shown as a toast: this needs an answer, and a
      // notification that disappears while you are reading it is not a question.
      if (!local.journeyAsks.some((a) => a.playerId === msg.playerId)) {
        local.journeyAsks.push({ playerId: msg.playerId, nickname: msg.nickname });
      }
      render();
      return;
    }

    case "journeyDecision": {
      toast(
        msg.approved
          ? `${msg.nickname} is letting you watch.`
          : `${msg.nickname} would rather you didn't.`,
        msg.approved ? "good" : "warn",
      );
      // Approved: the drawer is already open on them, so refresh it in place.
      if (msg.approved && local.journey?.playerId === msg.playerId) {
        send({ t: "journey", playerId: msg.playerId });
      }
      return;
    }

    case "buzz": {
      // The buzzer is in the audience too, so say which it was — "you buzzed the
      // room" is the confirmation that the button did something to other people.
      const mine = msg.playerId === state?.you?.id;
      receiveBuzz(msg.nickname, mine);
      toast(mine ? "You buzzed the room!" : `${msg.nickname} buzzed the room!`, "warn");
      return;
    }

    case "mentioned": {
      // The wording the request asked for, in as many words: somebody wants you
      // to look, and the toast should say who and where.
      toast(`${msg.fromNickname} tagged you in room feed`, "warn");
      receiveMention(msg.fromNickname);
      return;
    }

    case "reaction": {
      const me = state?.you?.id;
      receiveReaction({
        kind: msg.kind,
        fromId: msg.fromId,
        toId: msg.toId,
        // Both counters drive the escalation: `count` is this thrower's streak,
        // `total` is what the target has taken from the whole room.
        count: msg.count ?? 1,
        total: msg.total ?? 1,
        youAre: msg.toId === me ? "target" : msg.fromId === me ? "thrower" : "bystander",
      });
      // Only the person on the receiving end is told in words. The thrower just
      // watched it leave their hand, and everyone else has the feed.
      //
      // And only on the first one from each person, then every fifth: throwing is
      // unlimited, so one toast per throw would bury the room under its own
      // notifications. The animation is the running commentary.
      if (msg.toId === me && (msg.count <= 1 || msg.count % 5 === 0)) {
        const streak = msg.count > 1 ? ` — that is ${msg.count} now` : "";
        // Phrased from the glyph table rather than branched on here, so a fifth
        // reaction cannot end up being announced as an egg.
        const info = REACTIONS[msg.kind];
        toast(
          `${msg.fromNickname} ${info?.verb ?? "threw something at"} you ${info?.glyph ?? ""}`
            .trim() + streak,
          msg.kind === "rose" ? "good" : "warn",
        );
      }
      return;
    }

    case "invitable": {
      if (local.invitePicker) {
        local.invitePicker.people = msg.people ?? [];
        render();
      }
      return;
    }

    case "rooms": {
      local.liveRooms = {
        online: msg.online ?? 0,
        playing: msg.playing ?? 0,
        rooms: msg.rooms ?? [],
      };
      // Somebody following an invite link has chosen no game and cannot be asked
      // to: they were sent a table, not a menu. The room they are pointed at is
      // in this very list, so its mode answers the question and they get the
      // right setup page to type their name into.
      const linked = roomFromPath();
      if (!state && !local.game && linked) {
        const open = local.liveRooms.rooms.find((r) => r.code === linked);
        if (open) actions.chooseGame(gameOf(open.mode));
      }
      // Only the landing page shows this, and re-rendering the room screen for it
      // would be a pointless patch pass over a live game.
      if (!state) render();
      return;
    }

    case "invited": {
      // Ignore an invitation into the room you are already sitting in.
      if (state?.code === msg.code) return;
      // The real thing has arrived, so the "any second now" notice has done its
      // job — even if it came from somebody else, the dialog covers it anyway.
      local.inviteAhead = null;
      local.invite = { fromId: msg.fromId, fromNickname: msg.fromNickname, code: msg.code };
      render();
      return;
    }

    case "inviteAhead": {
      if (msg.cancel) {
        if (local.inviteAhead?.fromId === msg.fromId) {
          local.inviteAhead = null;
          render();
        }
        return;
      }
      local.inviteAhead = {
        fromId: msg.fromId,
        fromNickname: msg.fromNickname,
        at: Date.now(),
      };
      toast(
        `${msg.fromNickname} is putting a room together for you — the code lands here as soon as ` +
          "it exists.",
        "info",
      );
      render();
      return;
    }

    case "guessResult": {
      if (msg.accepted) {
        if (msg.rank === 1) toast("You found it!", "good");
      } else {
        toast(msg.message ?? "Rejected.", msg.reason === "duplicate" ? "warn" : "error");
        // Hand back an out-of-vocabulary word so it can be corrected in place.
        if (msg.reason === "unknown" && local.guessInput && !local.guessInput.value) {
          local.guessInput.value = msg.word;
          local.guessInput.select();
        }
      }
      return;
    }

    case "definition": {
      local.words.set(msg.word, { status: msg.status, note: msg.note ?? null });
      // Only redraw if the answer is for the panel actually on screen. Somebody
      // else's round should not repaint because an old lookup finally landed.
      if (local.openWord === msg.word) render();
      return;
    }

    case "monoMapResult":
      local.monoMapResult = {
        ok: msg.ok,
        name: msg.name,
        errors: msg.errors ?? [],
        warnings: msg.warnings ?? [],
      };
      if (msg.ok) {
        local.monoMapDraft = "";
        toast(`Đã tải bản đồ “${msg.name}”.`, "good");
      } else {
        toast("Bản đồ chưa dùng được.", "error");
      }
      render();
      return;

    case "toast":
      toast(msg.text, msg.level);
      return;

    case "kicked":
      toast(msg.reason, "error");
      leaveLocally();
      return;

    // The close code does the real work; this just gives a friendlier reason.
    case "superseded":
      toast(msg.message, "warn");
      return;

    case "assistReply":
      handleAssistReply(msg);
      return;

    case "error":
      toast(msg.message, "error");
      if (msg.code === "noRoom") leaveLocally();
      return;

    case "pong":
    default:
      return;
  }
}

function leaveLocally() {
  state = null;
  // Everything room-shaped goes with the room. None of it was ever stored
  // anywhere else, so leaving really is the end of it.
  local.journey = null;
  local.journeyAsks = [];
  local.invitePicker = null;
  local.inviteQueue.clear();
  local.emojiOpen = false;
  local.roomCode = null;
  // The record itself stays in localStorage — that is the one thing practice is
  // for. What goes is the copy on screen and the "already counted" set, so the
  // next room starts counting its own rounds.
  local.record = null;
  local.countedRounds.clear();
  // The board and everything half-typed against it. The remembered *game* is
  // not room-shaped and deliberately survives, so leaving a board game returns
  // to the board game's setup page.
  local.monoSelected = null;
  local.monoBid = null;
  local.monoTrade = null;
  local.monoMapDraft = "";
  local.monoMapResult = null;
  writeStore(STORE.room, null);
  if (location.pathname !== "/") history.replaceState(null, "", "/");
  render();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const actions = {
  setNickname(value) {
    local.nickname = value;
    writeStore(STORE.nickname, value);
    announcePresence();
  },

  create(config) {
    if (!local.nickname.trim()) {
      toast("Pick a name first.", "warn");
      $("nick")?.focus();
      return;
    }
    // Anyone ticked on the landing page is invited the moment the room exists,
    // which is what `hello` tells us. Held here rather than sent now because an
    // invitation has to name a room.
    pendingInvites = [...local.inviteQueue];
    send({ t: "create", nickname: local.nickname, config, playerId });
  },

  join(rawCode) {
    const code = String(rawCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!local.nickname.trim()) {
      toast("Pick a name first.", "warn");
      $("nick")?.focus();
      return;
    }
    if (code.length !== LIMITS.roomCodeLength) {
      toast(`Room codes are ${LIMITS.roomCodeLength} characters.`, "warn");
      return;
    }
    send({ t: "join", code, nickname: local.nickname, playerId });
  },

  leave() {
    send({ t: "leave" });
    leaveLocally();
  },

  guess(word) {
    send({ t: "guess", word });
  },

  hint() {
    send({ t: "hint" });
  },

  /**
   * Open the detail panel for a word, closing it if it was already open.
   *
   * The lookup is fired once per word per session: an entry already in `words`
   * needs no message, and one marked "asking" means somebody is already waiting on
   * the same answer.
   */
  toggleWord(word) {
    if (local.openWord === word) {
      local.openWord = null;
      render();
      return;
    }
    local.openWord = word;
    if (!local.words.has(word)) {
      local.words.set(word, { status: "asking" });
      send({ t: "define", word });
    }
    render();
    // Saying it is the part that always works, so it happens without waiting for
    // the server — and it is what somebody clicking a foreign word wants first.
    speak(word);
  },

  sayWord(word) {
    if (!speak(word)) toast("This browser cannot speak, sorry.", "warn");
  },

  config(patch) {
    send({ t: "config", patch });
  },

  /** Move somebody to a team. Defaults to yourself; the host may name anyone. */
  setTeam(teamId, playerId) {
    send({ t: "team", teamId, playerId: playerId ?? state?.you?.id });
  },

  shuffleTeams() {
    send({ t: "shuffleTeams" });
  },

  start() {
    send({ t: "start" });
  },

  next() {
    send({ t: "next" });
  },

  endRound() {
    send({ t: "endRound" });
  },

  endMatch() {
    send({ t: "endMatch" });
  },

  reset() {
    send({ t: "reset" });
  },

  /**
   * Open the journey drawer for one player and ask the server to fill it.
   *
   * Somebody else's run is fetched alongside your own, so the drawer can put the
   * two next to each other — a path to the word only means something compared
   * with another one.
   */
  openJourney(id) {
    local.journey = { playerId: id, data: null, mine: null, error: null };
    send({ t: "journey", playerId: id });
    if (id !== state?.you?.id) send({ t: "journey", playerId: state.you.id });
    render();
  },

  closeJourney() {
    local.journey = null;
    render();
  },

  /** Ask somebody to let you watch the round they are still playing. */
  askJourney(id) {
    send({ t: "journeyRequest", playerId: id });
  },

  /** Answer the person at the head of the queue. */
  answerJourney(id, approve) {
    local.journeyAsks = local.journeyAsks.filter((a) => a.playerId !== id);
    send({ t: "journeyDecide", playerId: id, approve });
    render();
  },

  buzz() {
    send({ t: "buzz" });
  },

  react(id, kind) {
    send({ t: "react", playerId: id, kind });
  },

  /**
   * Buy a hint past the allowance. Asks first, because the whole point is that
   * it costs something — a button that quietly puts you on the hook for a round
   * of drinks would be a worse joke and a worse button.
   */
  extraHint() {
    if (confirm(EXTRA_HINT_PROMPT)) send({ t: "extraHint" });
  },

  openInvitePicker() {
    local.invitePicker = { people: null };
    send({ t: "invitable" });
    render();
  },

  closeInvitePicker() {
    local.invitePicker = null;
    render();
  },

  /**
   * In a room: invite immediately. On the landing page: line them up for after
   * create — and tell them so now, because the gap between ticking a name and
   * pressing Create room is the one moment this whole feature used to be silent.
   */
  toggleInvitee(id) {
    const wasQueued = local.inviteQueue.has(id);
    if (wasQueued) local.inviteQueue.delete(id);
    else local.inviteQueue.add(id);
    if (state) {
      if (!wasQueued) send({ t: "invite", playerId: id });
    } else {
      send({ t: "inviteAhead", playerId: id, cancel: wasQueued });
    }
    render();
  },

  acceptInvite() {
    const invite = local.invite;
    if (!invite) return;
    local.invite = null;
    actions.join(invite.code);
  },

  declineInvite() {
    const invite = local.invite;
    if (!invite) return;
    local.invite = null;
    send({ t: "inviteDecline", playerId: invite.fromId });
    render();
  },

  /** Drop an emoji into whichever box the player is writing in. */
  insertEmoji(emoji) {
    rememberEmoji(emoji);
    const input = $("chatInput");
    if (input) {
      // At the caret, not the end: people reach for the palette mid-sentence.
      const at = input.selectionStart ?? input.value.length;
      const to = input.selectionEnd ?? at;
      input.value = input.value.slice(0, at) + emoji + input.value.slice(to);
      const caret = at + emoji.length;
      input.focus();
      input.setSelectionRange(caret, caret);
    }
    local.emojiOpen = false;
    render();
  },

  toggleEmoji() {
    local.emojiOpen = !local.emojiOpen;
    render();
  },

  openChangelog() {
    local.changelogOpen = true;
    // Reading it is what clears the dot, so it is marked here rather than on
    // close — someone who opens it and navigates away has still seen it.
    local.seenRelease = CURRENT_RELEASE;
    writeStore(STORE.seenRelease, String(CURRENT_RELEASE));
    render();
  },

  closeChangelog() {
    local.changelogOpen = false;
    render();
  },

  // The rulebook. A modal rather than a panel because it is long: forty-odd
  // lines read badly in a sidebar column, and a board game's rules are looked up
  // in one go and then put down again.
  openMonoRules() {
    local.monoRulesOpen = true;
    render();
  },

  closeMonoRules() {
    local.monoRulesOpen = false;
    render();
  },

  /** Flat board or 3D board. Remembered for next time. */
  monoView(mode) {
    local.monoView = mode === "2d" ? "2d" : "3d";
    writeStore(STORE.boardView, local.monoView);
    render();
  },

  chat(text) {
    send({ t: "chat", text });
  },

  kick(id) {
    send({ t: "kick", playerId: id });
  },

  promote(id) {
    send({ t: "promote", playerId: id });
  },

  // --- the board game -----------------------------------------------------

  /**
   * Pick a game, or pass null to go back to the chooser.
   *
   * The create form's mode moves with the choice, because a game and its modes
   * are the same decision — offering the board game and then creating a word
   * race would be a bug you could only see afterwards.
   */
  chooseGame(key) {
    local.game = GAME_KEYS.includes(key) ? key : null;
    writeStore(STORE.game, local.game ?? "");
    alignConfigToGame();
    local.monoMapResult = null;
    mountedScreen = null;
    render();
  },

  /** One move on the board. The server decides whether it was legal. */
  mono(action) {
    send({ t: "mono", action });
  },

  /**
   * Hand your turns to the machine, or take them back.
   *
   * Not a `mono` action: a spectator has no seat to move from, and this stays
   * legal while somebody else is mid-decision.
   */
  monoAuto(on) {
    send({ t: "monoAuto", on: Boolean(on) });
  },

  /** Ask the table to abandon this game and deal a new one. */
  monoRestart() {
    send({ t: "monoRestart" });
  },

  monoRestartVote(agree) {
    send({ t: "monoRestartVote", agree: Boolean(agree) });
  },

  /**
   * Send a board for the server to check.
   *
   * Parsed here only to catch a paste that is not JSON at all, which is worth a
   * message on the spot rather than a round trip. Everything about whether it is
   * a *usable board* is the server's call, and its answer is what gets shown.
   */
  loadMonoMap(text) {
    const raw = String(text ?? "").trim();
    if (!raw) {
      toast("Chưa có nội dung bản đồ.", "warn");
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      local.monoMapResult = { ok: false, errors: ["Không phải JSON hợp lệ."] };
      render();
      return;
    }
    // The wire carries `{t:"monoMap", map}`, and that one message has its own
    // ceiling on the server. Checked here too, so an oversized file is refused in
    // Vietnamese next to the box it came from rather than as a socket error.
    const frame = JSON.stringify({ t: "monoMap", map: parsed }).length;
    if (frame > LIMITS.maxMapBytes) {
      local.monoMapResult = {
        ok: false,
        errors: [
          `Tệp quá lớn: ${Math.round(frame / 1024)}KB, tối đa ${
            Math.round(LIMITS.maxMapBytes / 1024)
          }KB.`,
        ],
      };
      render();
      return;
    }
    send({ t: "monoMap", map: parsed });
  },

  /**
   * Hand the host the board currently chosen, as a file to edit.
   *
   * A built-in board is a far better starting point than a blank file and a
   * schema to read: rename the twenty-two places to your own streets and it is
   * still a valid board, because the prices were never in the file.
   */
  downloadMonoTemplate() {
    const id = state?.config?.monoMap ?? local.newConfig.monoMap;
    // A custom board that was loaded earlier is not a built-in, and the browser
    // was only ever sent its squares, not its source. The default board is the
    // honest thing to offer as a template in that case.
    const map = builtinMap(id) ?? builtinMap(DEFAULT_MAP_ID);
    const blob = new Blob([JSON.stringify(map, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: `ban-do-${map.id}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  /** A message that never left the browser, for the board game's own mishaps. */
  toastLocal(text, level) {
    toast(text, level);
  },

  /** The dock's one-click light/dark flip. Finer control lives in the assistant. */
  toggleTheme() {
    const resolved = document.documentElement.dataset.theme;
    updatePrefs({ mode: resolved === "dark" ? "light" : "dark" });
  },
};
local.actions = actions;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const ctx = {
  get state() {
    return state;
  },
  local,
  actions,
};

/**
 * Keep the create form building a room of the game that is on screen.
 *
 * The mode is the one setting the two games do not share, and the chooser is not
 * the only way to arrive at a setup page: a remembered choice skips it entirely,
 * which is how the board game once managed to create a word race. Stated as an
 * invariant over the config rather than as an assignment at each entry point, so
 * a third way in cannot forget it.
 */
function alignConfigToGame() {
  const modes = GAMES[local.game ?? "closeword"].modes;
  if (!modes.includes(local.newConfig.mode)) local.newConfig.mode = modes[0];
}

/**
 * Which of the four screens belongs on the page.
 *
 * In a room the room decides: its mode says which game it is, and joining by
 * link is the common case where this browser never chose anything. Out of a room
 * the remembered choice decides, and having chosen nothing is the chooser.
 */
function screenFor() {
  if (state) return gameOf(state.config.mode) === "monopoly" ? "monoRoom" : "room";
  if (local.game === "monopoly") return "monoLanding";
  if (local.game === "closeword") return "landing";
  return "gate";
}

const SCREENS = {
  gate: { build: buildGameGate, update: null },
  landing: { build: buildLanding, update: updateLanding },
  monoLanding: { build: buildMonoLanding, update: updateMonoLanding },
  room: { build: buildRoom, update: updateRoom },
  monoRoom: { build: buildMonoRoom, update: updateMonoRoom },
};

function render() {
  const screen = screenFor();
  const app = $("app");
  if (mountedScreen !== screen) {
    fill(app, SCREENS[screen].build(ctx));
    mountedScreen = screen;
    // Two games on one origin means two names for the tab. Set here rather than
    // in index.html, which cannot know which game is about to be drawn.
    document.title = screen === "gate"
      ? "CloseWord Party · Cờ tỷ phú"
      : GAMES[local.game ?? "closeword"].label;
  }
  SCREENS[screen].update?.(ctx);
}

// Keep the round clock moving between snapshots.
setInterval(() => {
  if (state?.phase === "playing") updateTimer(state, local);
}, 250);

/**
 * Refresh the open-room list while somebody is sitting on the landing page.
 *
 * Slow on purpose: rooms do not appear and vanish by the second, and this is a
 * poll on every idle browser rather than on one. `askForRooms` is the guard —
 * being in a room stops it.
 */
setInterval(() => {
  askForRooms();
  // A heads-up is a promise about the next few seconds, so it should not still be
  // sitting there minutes later if the person changed their mind and closed the
  // tab — a cancel can only arrive from a browser that is still open.
  if (local.inviteAhead && Date.now() - local.inviteAhead.at > INVITE_AHEAD_TTL_MS) {
    local.inviteAhead = null;
    render();
  }
}, 8000);

// Global shortcut: "/" jumps to the guess box, as in the original.
addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
    const input = $("guessInput");
    if (input && !input.disabled) {
      e.preventDefault();
      input.focus();
    }
  }
  // Escape backs out of whatever is covering the board, innermost first —
  // leaving the guess box unreachable is worse than a stray keystroke.
  if (e.key === "Escape") {
    if (local.emojiOpen) {
      e.preventDefault();
      local.emojiOpen = false;
      render();
    } else if (local.monoRulesOpen) {
      e.preventDefault();
      actions.closeMonoRules();
    } else if (local.changelogOpen) {
      e.preventDefault();
      actions.closeChangelog();
    } else if (local.invitePicker) {
      e.preventDefault();
      actions.closeInvitePicker();
    } else if (local.journey) {
      e.preventDefault();
      actions.closeJourney();
    }
  }
});

// The assistant is a fixed overlay, mounted once and independent of the screen.
// It gets a quiet sender: it reports a failure to send in its own transcript, so
// a toast on top of that would say the same thing twice.
mountAssistant({
  send: (message) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  },
});

// The status is checked before the body is trusted. /api/info answers 503 with
// `{ error }` when the game is not up, and everything downstream reads
// `info.ranker` without asking — storing an error body as if it were an answer
// turns a server that is merely down into an uncaught TypeError on the landing
// page. Same for a 200 that is not our payload at all, which is what a host that
// rewrites unknown paths to the app sends back.
fetch("/api/info")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`/api/info: ${r.status}`))))
  .then((info) => {
    if (!info?.ranker) throw new Error("/api/info: no ranker in the payload");
    local.serverInfo = info;
    setAssistantAvailable(info.assistant);
    render();
  })
  .catch(() => {
    local.serverInfoFailed = true;
    render();
  });

// A previous session in this browser resumes without retyping the code.
const remembered = readStore(STORE.room);
if (!local.pendingCode && remembered) local.pendingCode = remembered;
if (remembered && local.nickname && roomFromPath()) local.autoJoin = true;
// A remembered game skips the chooser, so nothing has aligned the create form yet.
alignConfigToGame();

render();
connect();
