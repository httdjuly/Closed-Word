// HTTP + WebSocket entry point.
//
// One Deno process holds every room and the whole embedding table in memory.
// That is the point of the design: the ranker's value comes from being resident,
// so there is nothing to gain from splitting this up until a single box runs out
// of cores.

import { contentType } from "@std/media-types";
import { extname, join, normalize, resolve, SEPARATOR } from "@std/path";

import { loadRanker, MissingPackError, type Ranker } from "./ranker.ts";
import { cleanNickname, Room, RoomError, sanitiseConfig, wordSourceStatuses } from "./room.ts";
import { MonopolyError } from "./monopoly.ts";
import { mapSummaries } from "../shared/monopoly_maps.js";
import { normaliseCode, RoomRegistry } from "./registry.ts";
import { createIconPicker } from "./wordicon.ts";
import { createDefiner, unavailableDefiner } from "./define.ts";
import { ClaudeTimeoutError } from "./ai_core.ts";
import { loadAi } from "./ai_runtime.ts";
import { assertConfigValid, config, configSummary } from "./config.ts";
import { log } from "./log.ts";
import { attachSignalHandlers, createShutdownHandler } from "./shutdown.ts";
import {
  DEFAULT_CONFIG,
  isSoloMode,
  LIMITS,
  REACTION_KEYS,
  WORD_SOURCES,
} from "../shared/constants.js";
import type {
  ClientMessage,
  OnlinePerson,
  OpenRoom,
  ServerMessage,
  WordNote,
} from "../shared/protocol.ts";

/**
 * Every tunable now comes from server/config.ts, which reads `.env`. The
 * assistant in particular is metered separately from everything else, because
 * unlike a guess or a chat line it spawns a `claude` subprocess — one in flight
 * per player plus a per-minute cap stops a roomful of bored players forking a
 * process each.
 */
assertConfigValid();
const ASSIST_WINDOW_MS = 60_000;

/**
 * Application close code for "another connection took over this player id".
 * Must be in the 4000-4999 private range so it survives intermediaries, and must
 * be distinguishable from a network drop so the retired client does not
 * reconnect and start a supersede war with the tab that displaced it.
 */
export const CLOSE_SUPERSEDED = 4001;

interface Session {
  socket: WebSocket;
  playerId: string;
  code: string | null;
  msgTimes: number[];
  /** Assistant calls in the current window, and whether one is outstanding. */
  assistTimes: number[];
  assistBusy: boolean;
  /**
   * The name this browser is going by, so other people can invite them.
   *
   * Lives here and nowhere else: it is never written to disk, never in a room
   * snapshot unless they actually join one, and it disappears the moment the
   * socket closes. That is the whole storage design for invites — the browser
   * keeps the name in its own localStorage and re-announces it on connect.
   */
  nickname: string;
  /** Invites sent recently, for the rate limit. */
  inviteTimes: number[];
  /** Word lookups recently, for the rate limit. */
  defineTimes: number[];
}

/** One person may fire this many invites a minute. Enough to gather a room. */
const INVITE_WINDOW_MS = 60_000;
const INVITES_PER_WINDOW = 20;

/**
 * Word lookups per minute per person.
 *
 * Each miss costs a subprocess, so this is the real cost control; cache hits are
 * free but still counted, because a client cannot be trusted to know which is
 * which. Twenty is far more than reading a board calls for and far less than a
 * script could do damage with.
 */
const DEFINE_WINDOW_MS = 60_000;
const DEFINES_PER_WINDOW = 20;

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const sessions = new Set<Session>();
/** playerId -> session, for targeted sends. One connection per player id wins. */
const byPlayer = new Map<string, Session>();
const pendingBroadcasts = new Set<string>();

log.service("starting", { pid: Deno.pid, deno: Deno.version.deno, cwd: Deno.cwd() });

let ranker: Ranker;
try {
  const startedAt = Date.now();
  ranker = await loadRanker(config.packPath, config.secretPoolPath, {
    cacheSize: config.rankCacheSize,
  });
  const packStats = ranker.stats();
  log.service("pack loaded", {
    path: config.packPath,
    words: packStats.vocabSize,
    dims: packStats.dim,
    sample: packStats.sample,
    ms: Date.now() - startedAt,
  });
} catch (err) {
  if (err instanceof MissingPackError) {
    log.error("service", "no embedding pack", err, { path: config.packPath });
    console.error(`\n${err.message}`);
    Deno.exit(1);
  }
  log.error("service", "could not load the pack", err);
  throw err;
}

/**
 * The AI backend, resolved once. In a production build `ai.ts` is not there and
 * this is the stub, which answers `claudeAvailable()` with a plain false — the
 * same state the server has always handled for a machine with no `claude`
 * installed, so nothing downstream needs a second code path.
 */
const ai = await loadAi();

const hasClaude = config.claude.mode === "off" ? false : await ai.claudeAvailable();
/** Clues and chat share a dependency but not a switch — either can be off alone. */
const hasAssistant = hasClaude && config.assist.enabled;

/**
 * One picker for the whole process, so its memo is shared by every room: the
 * words people guess overlap heavily, and the second room to see "sandwich" gets
 * the answer for free.
 */
const iconFor = createIconPicker(ranker);

/**
 * The word-lookup service. Needs `claude`, and says so rather than hanging when it
 * is absent — the browser's own speech synthesis covers pronunciation either way,
 * so the panel is still worth opening on a server with no model at all.
 */
const definer = hasClaude ? createDefiner(ai) : unavailableDefiner();

const registry = new RoomRegistry({
  ranker,
  icon: iconFor,
  clueProvider: hasClaude ? ai.createClaudeClueProvider() : null,
  onChange: (room) => scheduleBroadcast(room),
  idleTtlMs: config.rooms.idleTtlMs,
  sweepIntervalMs: config.rooms.sweepIntervalMs,
  maxRooms: config.rooms.maxRooms,
});
registry.startSweeper();

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

function send(session: Session, message: ServerMessage): void {
  if (session.socket.readyState !== WebSocket.OPEN) return;
  try {
    session.socket.send(JSON.stringify(message));
  } catch (err) {
    log.error("http", "websocket send failed", err, {
      player: session.playerId,
      room: session.code,
      type: message.t,
    });
  }
}

function sendState(session: Session, room: Room): void {
  send(session, { t: "state", room: room.viewFor(session.playerId) });
}

/**
 * Every player gets their own snapshot because boards are redacted per
 * recipient — you never receive another board's guesses over the wire, so a
 * curious player cannot read them out of devtools.
 */
function broadcast(room: Room): void {
  for (const playerId of room.players.keys()) {
    const session = byPlayer.get(playerId);
    if (session && session.code === room.code) sendState(session, room);
  }
}

function scheduleBroadcast(room: Room): void {
  if (pendingBroadcasts.has(room.code)) return;
  pendingBroadcasts.add(room.code);
  setTimeout(() => {
    pendingBroadcasts.delete(room.code);
    broadcast(room);
  }, config.socket.broadcastDebounceMs);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

const PLAYER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function validPlayerId(raw: unknown): string | null {
  return typeof raw === "string" && PLAYER_ID_RE.test(raw) ? raw : null;
}

function detach(session: Session): void {
  if (!session.code) return;
  const room = registry.get(session.code);
  session.code = null;
  if (!room) return;
  room.disconnect(session.playerId);
  if (room.isEmpty) registry.delete(room.code);
}

function attach(session: Session, room: Room, nickname: string): void {
  if (session.code && session.code !== room.code) detach(session);
  const player = room.join(session.playerId, nickname);
  // Keep the session's copy current so the invite directory shows the name they
  // are actually playing under, disambiguating suffix and all.
  session.nickname = player.nickname;
  session.code = room.code;
  send(session, { t: "hello", playerId: session.playerId, code: room.code });
  sendState(session, room);
}

/**
 * Everyone else with the app open who has told us what to call them.
 *
 * Built fresh from the live sockets on every request rather than kept as a
 * roster: a stale directory of who is around is worse than none, and there is
 * nothing here worth storing between two calls. Nameless sessions are left out
 * because "invite ?" is not an invitation.
 */
function invitablePeople(asker: Session): OnlinePerson[] {
  const people: OnlinePerson[] = [];
  for (const other of sessions) {
    if (other === asker || !other.nickname) continue;
    // Same person, second tab. `invite` rejects it anyway, so offering it would
    // only be a button that throws an error at whoever pressed it.
    if (other.playerId === asker.playerId) continue;
    if (other.socket.readyState !== WebSocket.OPEN) continue;
    // Already in the room you are inviting into: nothing to offer them.
    if (asker.code && other.code === asker.code) continue;
    people.push({ id: other.playerId, nickname: other.nickname, busy: other.code !== null });
  }
  return people
    .sort((a, b) => Number(a.busy) - Number(b.busy) || a.nickname.localeCompare(b.nickname))
    .slice(0, LIMITS.maxPlayers * 2);
}

/**
 * Rooms anybody could walk into, newest-looking first.
 *
 * This is the one place the server volunteers room codes to somebody who was
 * not invited, which is a deliberate trade: the app is built for a team on one
 * network, and "what is everyone playing?" is the question the landing page
 * exists to answer. Two things keep it honest — solo rooms are never listed,
 * because a closed door that advertises itself is not closed, and no room
 * publishes who is in it.
 */
function openRooms(): OpenRoom[] {
  const rooms: OpenRoom[] = [];
  for (const room of registry.rooms()) {
    if (isSoloMode(room.config.mode)) continue;
    if (room.connectedCount === 0) continue;
    rooms.push({
      code: room.code,
      mode: room.config.mode,
      wordSource: room.config.wordSource,
      phase: room.phase,
      players: room.connectedCount,
      capacity: LIMITS.maxPlayers,
      joinable: room.players.size < LIMITS.maxPlayers,
      round: room.round,
      totalRounds: room.totalRounds,
    });
  }
  // Busiest first, then by code so the order is stable between polls — a list
  // that reshuffles under the cursor is a list nobody can click.
  return rooms.sort((a, b) => b.players - a.players || a.code.localeCompare(b.code));
}

/** How many connected players are sitting in a room right now, solo included. */
function countInRooms(): number {
  let n = 0;
  for (const room of registry.rooms()) n += room.connectedCount;
  return n;
}

function requireRoom(session: Session): Room {
  if (!session.code) throw new RoomError("noRoom", "You are not in a room.");
  const room = registry.get(session.code);
  if (!room) {
    session.code = null;
    throw new RoomError("noRoom", "That room no longer exists.");
  }
  return room;
}

/**
 * The private assistant behind the floating chat button.
 *
 * Deliberately outside the room state machine: it needs no room (it works on the
 * landing screen), it never broadcasts, and nothing about a player's questions or
 * their chosen appearance is stored anywhere on this server. The reply goes to
 * the one socket that asked.
 */
function handleAssist(session: Session, msg: Extract<ClientMessage, { t: "assist" }>): void {
  const id = typeof msg.id === "string" ? msg.id.slice(0, 32) : "";
  // Without a correlation id the client could not match a reply, so there is
  // nothing useful to do — not even report the error.
  if (!id) return;

  const fail = (error: string) => send(session, { t: "assistReply", id, error });

  const text = String(msg.text ?? "").trim().slice(0, config.assist.maxChars);
  if (!text) return fail("There was nothing to answer.");
  if (!hasAssistant) {
    return fail(
      hasClaude
        ? "Chat is switched off on this server (CLOSEWORD_ASSISTANT=false). " +
          "Everything in the Look tab still works."
        : "This server has no `claude` command available, so chat is off. " +
          "Everything in the Look tab still works.",
    );
  }
  if (session.assistBusy) return fail("Still thinking about the last one.");

  const now = Date.now();
  session.assistTimes = session.assistTimes.filter((t) => now - t < ASSIST_WINDOW_MS);
  if (session.assistTimes.length >= config.assist.perMinute) {
    return fail("That is a lot of questions at once — give it a minute.");
  }
  session.assistTimes.push(now);
  session.assistBusy = true;

  // The question itself is never logged — it is a private conversation, and the
  // player may well be asking about the round they are in.
  const startedAt = Date.now();
  log.webhook("assist requested", { player: session.playerId, chars: text.length });

  ai.assist({
    text,
    prefs: msg.prefs && typeof msg.prefs === "object" ? msg.prefs : {},
    history: Array.isArray(msg.history) ? msg.history : [],
  })
    .then((result) => {
      log.webhook("assist answered", {
        player: session.playerId,
        ms: Date.now() - startedAt,
        chars: result.text.length,
        restyled: Object.keys(result.patch ?? {}).length,
      });
      send(session, { t: "assistReply", id, text: result.text, patch: result.patch });
    })
    .catch((err) => {
      const timedOut = err instanceof ClaudeTimeoutError;
      log.error("webhook", timedOut ? "assist timed out" : "assist failed", err, {
        player: session.playerId,
        ms: Date.now() - startedAt,
      });
      fail(
        timedOut
          ? "That took longer than I was willing to wait. Try asking something smaller?"
          : "The assistant did not manage to answer that time. Try again?",
      );
    })
    .finally(() => {
      session.assistBusy = false;
    });
}

/**
 * Answer one word lookup.
 *
 * Deliberately not gated on being in a room or on the word being on your board.
 * A definition is a fact about English, not about the round: it cannot narrow the
 * secret, and somebody checking what a word means *before* they spend a guess on
 * it is the case this was asked for. The only gate is the rate limit.
 *
 * Always replies. A panel showing a spinner forever is the one outcome worse than
 * "could not look that up".
 */
function handleDefine(session: Session, msg: Extract<ClientMessage, { t: "define" }>): void {
  const word = String(msg.word ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]{1,32}$/.test(word) || !/[a-z]/.test(word)) return;

  const reply = (status: "ok" | "unknown" | "unavailable" | "failed", note?: WordNote) =>
    send(session, { t: "definition", word, note, status });

  if (!definer.available) return reply("unavailable");

  const now = Date.now();
  session.defineTimes = session.defineTimes.filter((t) => now - t < DEFINE_WINDOW_MS);
  if (session.defineTimes.length >= DEFINES_PER_WINDOW) return reply("failed");
  session.defineTimes.push(now);

  definer.lookUp(word)
    .then((note) => reply(note ? "ok" : "unknown", note ?? undefined))
    .catch(() => reply("failed"));
}

function handleMessage(session: Session, msg: ClientMessage): void {
  switch (msg.t) {
    case "ping":
      send(session, { t: "pong" });
      return;

    case "create": {
      const room = registry.create(sanitiseConfig({ ...DEFAULT_CONFIG, ...(msg.config ?? {}) }));
      attach(session, room, msg.nickname);
      // Practice has nobody to wait for, so waiting for a host to press Start
      // would just be a lobby with one button in it. A failure here — no playable
      // words for the chosen source — still leaves them in the lobby with the
      // reason, which is exactly where that is fixable.
      if (isSoloMode(room.config.mode)) {
        try {
          room.start(session.playerId);
        } catch (err) {
          if (err instanceof RoomError) {
            send(session, { t: "error", code: err.code, message: err.message });
          } else throw err;
        }
      }
      log.action("room created", {
        room: room.code,
        mode: room.config.mode,
        source: room.config.wordSource,
        difficulty: room.config.difficulty,
        by: session.playerId,
        rooms: registry.size,
      });
      return;
    }

    case "join": {
      const code = normaliseCode(msg.code);
      const room = registry.get(code);
      if (!room) {
        log.action("join refused", { room: code, by: session.playerId, reason: "noRoom" });
        send(session, { t: "error", code: "noRoom", message: `No room with code ${code}.` });
        return;
      }
      attach(session, room, msg.nickname);
      log.action("player joined", {
        room: room.code,
        player: session.playerId,
        nickname: msg.nickname,
        players: room.players.size,
      });
      return;
    }

    case "leave": {
      const code = session.code;
      detach(session);
      log.action("player left", { room: code, player: session.playerId });
      send(session, { t: "toast", level: "info", text: "You left the room." });
      return;
    }

    case "guess": {
      const room = requireRoom(session);
      const outcome = room.guess(session.playerId, String(msg.word ?? ""));
      // Guesses only at debug. At info they would put every player's board on the
      // host's screen, and the host is usually playing.
      log.debug("action", "guess", {
        room: room.code,
        player: session.playerId,
        word: outcome.word,
        rank: outcome.rank,
        accepted: outcome.accepted,
      });
      if (outcome.accepted) {
        if (outcome.rank === 1) {
          log.action("word found", { room: room.code, player: session.playerId });
        }
        send(session, {
          t: "guessResult",
          accepted: true,
          word: outcome.word,
          rank: outcome.rank,
        });
      } else {
        send(session, {
          t: "guessResult",
          accepted: false,
          word: outcome.word,
          rank: outcome.rank,
          reason: outcome.reason,
          message: outcome.message,
        });
      }
      return;
    }

    case "extraHint": {
      const room = requireRoom(session);
      const { word, rank, drinks } = room.extraHint(session.playerId);
      // Worth an audit line at info: it is the one action that changes what
      // somebody owes, and the feed post is in their name.
      log.action("extra hint bought", { room: room.code, player: session.playerId, drinks });
      log.debug("action", "hint", { room: room.code, player: session.playerId, word, rank });
      send(session, {
        t: "toast",
        level: "info",
        text: `Hint: "${word}" is rank ${rank}. That's ${drinks} drink${
          drinks === 1 ? "" : "s"
        } you owe the room 🍻`,
      });
      return;
    }

    case "buzz": {
      const room = requireRoom(session);
      const { nickname, recipients } = room.buzz(session.playerId);
      log.action("buzz", { room: room.code, player: session.playerId, reached: recipients.length });
      for (const id of recipients) {
        const target = byPlayer.get(id);
        if (target && target.code === room.code) {
          send(target, { t: "buzz", playerId: session.playerId, nickname });
        }
      }
      return;
    }

    case "react": {
      const room = requireRoom(session);
      const target = validPlayerId(msg.playerId);
      if (!target) throw new RoomError("badTarget", "Invalid player.");
      // Checked against the declared list rather than a literal, which is how a
      // third reaction previously arrived and got silently thrown as a rose. An
      // unknown kind is rejected outright: coercing it makes a client bug look
      // like a server one.
      if (!REACTION_KEYS.includes(msg.kind)) {
        throw new RoomError("badTarget", "No such reaction.");
      }
      const kind = msg.kind;
      const { actorNickname, targetNickname, count, total, audience } = room.react(
        session.playerId,
        target,
        kind,
      );
      log.debug("action", "reaction", {
        room: room.code,
        by: session.playerId,
        player: target,
        kind,
      });
      for (const id of audience) {
        const watcher = byPlayer.get(id);
        if (watcher && watcher.code === room.code) {
          send(watcher, {
            t: "reaction",
            kind,
            fromId: session.playerId,
            fromNickname: actorNickname,
            toId: target,
            toNickname: targetNickname,
            count,
            total,
          });
        }
      }
      return;
    }

    case "journeyRequest": {
      const room = requireRoom(session);
      const target = validPlayerId(msg.playerId);
      if (!target) throw new RoomError("badTarget", "Invalid player.");
      const { targetNickname, viewerNickname } = room.requestJourney(session.playerId, target);
      const owner = byPlayer.get(target);
      if (!owner || owner.code !== room.code) {
        throw new RoomError("offline", `${targetNickname} is not connected to answer.`);
      }
      send(owner, { t: "journeyAsk", playerId: session.playerId, nickname: viewerNickname });
      send(session, {
        t: "toast",
        level: "info",
        text: `Asked ${targetNickname} if you can watch their round.`,
      });
      return;
    }

    case "journeyDecide": {
      const room = requireRoom(session);
      const viewer = validPlayerId(msg.playerId);
      if (!viewer) throw new RoomError("badTarget", "Invalid player.");
      const approve = msg.approve === true;
      room.decideJourney(session.playerId, viewer, approve);
      const asker = byPlayer.get(viewer);
      const me = room.players.get(session.playerId);
      if (asker && asker.code === room.code && me) {
        send(asker, {
          t: "journeyDecision",
          playerId: session.playerId,
          nickname: me.nickname,
          approved: approve,
        });
      }
      return;
    }

    case "hint": {
      const room = requireRoom(session);
      const { word, rank } = room.hint(session.playerId);
      // The hint word itself is a step towards the answer, so it stays at debug
      // for the same reason guesses do.
      log.action("hint used", { room: room.code, player: session.playerId });
      log.debug("action", "hint", { room: room.code, player: session.playerId, word, rank });
      send(session, { t: "toast", level: "info", text: `Hint: "${word}" is rank ${rank}.` });
      return;
    }

    case "config": {
      const room = requireRoom(session);
      room.setConfig(session.playerId, msg.patch ?? {});
      return;
    }

    case "team": {
      const room = requireRoom(session);
      const target = validPlayerId(msg.playerId) ?? session.playerId;
      const teamId = msg.teamId === null ? null : Number(msg.teamId);
      room.setTeam(session.playerId, target, teamId);
      return;
    }

    case "shuffleTeams": {
      requireRoom(session).shuffleTeams(session.playerId);
      return;
    }

    case "start": {
      const room = requireRoom(session);
      room.start(session.playerId);
      log.action("round started", {
        room: room.code,
        mode: room.config.mode,
        source: room.config.wordSource,
        difficulty: room.config.difficulty,
        round: room.round,
        players: room.players.size,
      });
      return;
    }

    case "next": {
      const room = requireRoom(session);
      room.next(session.playerId);
      log.action("next round", { room: room.code, round: room.round });
      return;
    }

    case "endRound": {
      const room = requireRoom(session);
      room.endRound(session.playerId);
      log.action("round ended", { room: room.code, round: room.round, by: session.playerId });
      return;
    }

    case "endMatch": {
      const room = requireRoom(session);
      room.endMatch(session.playerId);
      log.action("match ended", { room: room.code, round: room.round, by: session.playerId });
      return;
    }

    case "reset": {
      const room = requireRoom(session);
      room.reset(session.playerId);
      log.action("room reset", { room: room.code, by: session.playerId });
      return;
    }

    case "journey": {
      const room = requireRoom(session);
      const target = validPlayerId(msg.playerId);
      if (!target) throw new RoomError("badTarget", "Invalid player.");
      const journey = room.journeyFor(session.playerId, target);
      send(session, {
        t: "journey",
        journey,
        message: journey ? undefined : "No journey for that player yet.",
      });
      return;
    }

    case "presence": {
      // Memory only, and only for as long as this socket lives. The browser is
      // the one storing the name; this is a copy so other people can address an
      // invite to it.
      session.nickname = cleanNickname(String(msg.nickname ?? ""));
      return;
    }

    case "invitable": {
      send(session, { t: "invitable", people: invitablePeople(session) });
      return;
    }

    case "rooms": {
      send(session, {
        t: "rooms",
        online: sessions.size,
        playing: countInRooms(),
        rooms: openRooms(),
      });
      return;
    }

    case "invite": {
      const target = validPlayerId(msg.playerId);
      if (!target || target === session.playerId) {
        throw new RoomError("badTarget", "Invalid player.");
      }
      // An invite has to name a room, so the inviter must be in one. On the
      // create screen the client waits for `hello` and then sends these.
      const room = requireRoom(session);
      const now = Date.now();
      session.inviteTimes = session.inviteTimes.filter((t) => now - t < INVITE_WINDOW_MS);
      if (session.inviteTimes.length >= INVITES_PER_WINDOW) {
        throw new RoomError("tooFast", "That is a lot of invitations — give it a minute.");
      }
      const guest = byPlayer.get(target);
      if (!guest || guest.socket.readyState !== WebSocket.OPEN) {
        throw new RoomError("offline", "They just closed the app.");
      }
      if (guest.code === room.code) throw new RoomError("already", "They are already here.");
      session.inviteTimes.push(now);
      const me = room.players.get(session.playerId);
      const fromNickname = me?.nickname || session.nickname || "someone";
      send(guest, { t: "invited", fromId: session.playerId, fromNickname, code: room.code });
      log.action("invite sent", { room: room.code, from: session.playerId, to: target });
      send(session, {
        t: "toast",
        level: "info",
        text: `Invited ${guest.nickname || "them"}.`,
      });
      return;
    }

    case "inviteAhead": {
      const target = validPlayerId(msg.playerId);
      if (!target || target === session.playerId) {
        throw new RoomError("badTarget", "Invalid player.");
      }
      // Only meaningful from somebody with no room. In a room the client sends a
      // real invitation instead, and a heads-up for a room that already exists
      // would be a worse version of the thing it is standing in for.
      if (session.code) return;
      const guest = byPlayer.get(target);
      if (!guest || guest.socket.readyState !== WebSocket.OPEN) return;
      if (!msg.cancel) {
        // Shares the invite budget: a heads-up is cheap to send and just as
        // annoying to receive, so it counts against the same window.
        const now = Date.now();
        session.inviteTimes = session.inviteTimes.filter((t) => now - t < INVITE_WINDOW_MS);
        if (session.inviteTimes.length >= INVITES_PER_WINDOW) {
          throw new RoomError("tooFast", "That is a lot of invitations — give it a minute.");
        }
        session.inviteTimes.push(now);
      }
      send(guest, {
        t: "inviteAhead",
        fromId: session.playerId,
        fromNickname: session.nickname || "Somebody",
        cancel: Boolean(msg.cancel),
      });
      log.debug("action", "invite ahead", {
        by: session.playerId,
        player: target,
        cancel: Boolean(msg.cancel),
      });
      return;
    }

    case "inviteDecline": {
      const target = validPlayerId(msg.playerId);
      if (!target) return;
      const inviter = byPlayer.get(target);
      if (!inviter) return;
      send(inviter, {
        t: "toast",
        level: "warn",
        text: `${session.nickname || "They"} passed on your invitation.`,
      });
      return;
    }

    case "mono": {
      const room = requireRoom(session);
      const action = msg.action;
      if (!action || typeof action !== "object" || typeof action.a !== "string") {
        throw new RoomError("badAction", "Nước đi không hợp lệ.");
      }
      room.monoAction(session.playerId, action);
      // One line per move at info: a Monopoly game is a few hundred moves, not a
      // few thousand guesses, so the whole game fits in the log at this level and
      // "who bought what when" is exactly what you want when somebody disputes it.
      log.action("monopoly move", {
        room: room.code,
        player: session.playerId,
        move: action.a,
      });
      return;
    }

    case "monoAuto": {
      const room = requireRoom(session);
      room.monoAuto(session.playerId, Boolean(msg.on));
      return;
    }

    case "monoRestart": {
      const room = requireRoom(session);
      room.monoRestartAsk(session.playerId);
      log.action("monopoly restart asked", { room: room.code, by: session.playerId });
      return;
    }

    case "monoRestartVote": {
      const room = requireRoom(session);
      room.monoRestartVote(session.playerId, Boolean(msg.agree));
      return;
    }

    case "monoMap": {
      const room = requireRoom(session);
      const result = room.loadMonoMap(session.playerId, msg.map);
      send(session, {
        t: "monoMapResult",
        ok: result.ok,
        name: result.name,
        errors: result.errors,
        warnings: result.warnings,
      });
      log.action("monopoly map loaded", {
        room: room.code,
        by: session.playerId,
        ok: result.ok,
        name: result.name,
        problems: result.errors.length,
      });
      return;
    }

    case "chat": {
      const room = requireRoom(session);
      const mentions = room.chat(session.playerId, String(msg.text ?? ""));
      // The line itself reaches everybody in the next snapshot. This is the extra
      // nudge for the people it named, and only they get it — a notification
      // everybody receives is not a notification.
      const from = room.players.get(session.playerId)?.nickname ?? "Somebody";
      for (const id of mentions) {
        const target = byPlayer.get(id);
        if (target && target.code === room.code) {
          send(target, { t: "mentioned", fromId: session.playerId, fromNickname: from });
        }
      }
      return;
    }

    case "assist": {
      handleAssist(session, msg);
      return;
    }

    case "define": {
      handleDefine(session, msg);
      return;
    }

    case "promote": {
      const room = requireRoom(session);
      const target = validPlayerId(msg.playerId);
      if (!target) throw new RoomError("badTarget", "Invalid player.");
      room.promote(session.playerId, target);
      // Moderation is worth an audit trail: these are the actions someone asks
      // about afterwards.
      log.action("host handed over", { room: room.code, from: session.playerId, to: target });
      return;
    }

    case "kick": {
      const room = requireRoom(session);
      if (session.playerId !== room.hostId) {
        throw new RoomError("notHost", "Only the host can remove players.");
      }
      const target = validPlayerId(msg.playerId);
      if (!target || target === session.playerId) {
        throw new RoomError("badTarget", "Invalid player.");
      }
      const victim = byPlayer.get(target);
      room.remove(target);
      log.action("player removed", { room: room.code, by: session.playerId, player: target });
      // `byPlayer` is keyed by player id across the whole server, so it can hand
      // back a session that has since moved on. A room only ever gets to close
      // its own door: someone who left room A for room B is still listed here
      // while the match runs, and kicking that ghost must not throw them out of
      // the room they are actually sitting in.
      if (victim && victim.code === room.code) {
        victim.code = null;
        send(victim, { t: "kicked", reason: "The host removed you from the room." });
      }
      return;
    }

    default: {
      const unknown = msg as { t?: unknown };
      send(session, {
        t: "error",
        code: "badMessage",
        message: `Unknown message type ${JSON.stringify(unknown.t)}.`,
      });
    }
  }
}

/**
 * The size ceiling for one frame.
 *
 * Everything a client sends is a sentence — a guess, a chat line, a button
 * press — except a board file, which is a document and runs to ten kilobytes.
 * Rather than raise the ceiling for all of them, the big one is granted to the
 * frame that *claims* to be a board and then confirmed against the parsed
 * message below: a 60KB chat line is still refused.
 */
function frameLimit(raw: string): number {
  return raw.includes('"monoMap"') ? config.socket.maxMapBytes : config.socket.maxMessageBytes;
}

function onSocketMessage(session: Session, raw: string | ArrayBufferLike | Blob): void {
  if (typeof raw !== "string") {
    send(session, { t: "error", code: "badMessage", message: "Binary frames are not accepted." });
    return;
  }
  const limit = frameLimit(raw);
  if (raw.length > limit) {
    log.warn("http", "oversized frame rejected", {
      player: session.playerId,
      bytes: raw.length,
      limit,
    });
    send(session, {
      t: "error",
      code: "tooBig",
      message: `Message too large (${raw.length} bytes, limit ${limit}).`,
    });
    return;
  }

  const now = Date.now();
  session.msgTimes = session.msgTimes.filter((t) => now - t < config.socket.msgWindowMs);
  session.msgTimes.push(now);
  if (session.msgTimes.length > config.socket.msgLimit) {
    log.warn("http", "socket closed for flooding", {
      player: session.playerId,
      room: session.code,
      messages: session.msgTimes.length,
      windowMs: config.socket.msgWindowMs,
    });
    send(session, { t: "error", code: "flood", message: "Too many messages." });
    session.socket.close(1008, "flooding");
    return;
  }

  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    send(session, { t: "error", code: "badJson", message: "Malformed message." });
    return;
  }
  if (!msg || typeof msg !== "object" || typeof msg.t !== "string") {
    send(session, { t: "error", code: "badMessage", message: "Malformed message." });
    return;
  }

  // The big ceiling was granted on the strength of the word "monoMap" appearing
  // somewhere in the text. Now that the message is parsed, hold it to that.
  if (raw.length > config.socket.maxMessageBytes && msg.t !== "monoMap") {
    log.warn("http", "oversized frame rejected", {
      player: session.playerId,
      bytes: raw.length,
      limit: config.socket.maxMessageBytes,
      type: msg.t,
    });
    send(session, { t: "error", code: "tooBig", message: "Message too large." });
    return;
  }

  try {
    handleMessage(session, msg);
  } catch (err) {
    if (err instanceof RoomError || err instanceof MonopolyError) {
      // Expected refusals — "not the host", "no room", "chưa tới lượt bạn".
      // Debug, not error: at info they would drown the real failures in ordinary
      // rule enforcement, and in a board game most of the traffic *is* rule
      // enforcement — every mistimed click arrives here.
      log.debug("action", "refused", {
        type: msg.t,
        room: session.code,
        player: session.playerId,
        reason: err.code,
      });
      send(session, { t: "error", code: err.code, message: err.message });
    } else {
      log.error("action", "handler crashed", err, {
        type: msg.t,
        room: session.code,
        player: session.playerId,
      });
      send(session, { t: "error", code: "internal", message: "Something went wrong." });
    }
  }
}

function handleUpgrade(req: Request, remote: string): Response {
  const url = new URL(req.url);
  const playerId = validPlayerId(url.searchParams.get("id"));
  if (!playerId) {
    log.warn("http", "websocket upgrade refused", { remote, reason: "malformed id" });
    return new Response("missing or malformed id", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const session: Session = {
    socket,
    playerId,
    code: null,
    msgTimes: [],
    assistTimes: [],
    assistBusy: false,
    nickname: "",
    inviteTimes: [],
    defineTimes: [],
  };

  socket.onopen = () => {
    // A reconnect (or a second tab) supersedes the previous connection for this
    // player id, so the old socket is retired rather than left half-alive.
    const previous = byPlayer.get(playerId);
    if (previous && previous !== session) {
      const inherited = previous.code;
      previous.code = null;
      sessions.delete(previous);
      // Closing with an application code matters: the retired client must know
      // it was deliberately displaced. Treated as a normal drop it would
      // reconnect, displace this socket in turn, and the two tabs would
      // supersede each other forever with neither ever able to play.
      send(previous, {
        t: "superseded",
        message: "You opened CloseWord in another tab or window.",
      });
      try {
        previous.socket.close(CLOSE_SUPERSEDED, "superseded");
      } catch {
        // Already closing.
      }
      if (inherited) session.code = inherited;
      log.action("connection superseded", { player: playerId, room: inherited });
    }
    sessions.add(session);
    byPlayer.set(playerId, session);
    log.http("websocket open", { player: playerId, remote, sessions: sessions.size });

    // If they were mid-match, put them straight back in.
    if (session.code) {
      const room = registry.get(session.code);
      if (room && room.players.has(playerId)) {
        room.join(playerId, room.players.get(playerId)!.nickname);
        send(session, { t: "hello", playerId, code: room.code });
        sendState(session, room);
      } else {
        session.code = null;
      }
    }
  };

  socket.onmessage = (event) => onSocketMessage(session, event.data);

  socket.onclose = (event) => {
    sessions.delete(session);
    if (byPlayer.get(playerId) === session) byPlayer.delete(playerId);
    const room = session.code;
    detach(session);
    log.http("websocket closed", {
      player: playerId,
      room,
      code: event.code,
      sessions: sessions.size,
    });
  };

  socket.onerror = (event) => {
    const detail = event instanceof ErrorEvent ? event.message : "unknown";
    if (detail !== "unknown") {
      log.warn("http", "websocket error", { player: playerId, detail });
    }
  };

  return response;
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const ROOT = resolve(new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SERVED_DIRS = ["client", "shared"];
/** Only assets the browser actually loads. Keeps `.ts` sources off the wire. */
const SERVED_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".css",
  ".svg",
  ".png",
  ".jpg",
  ".webp",
  ".ico",
  ".woff2",
  ".json",
  ".map",
]);

/**
 * How long the browser may keep an asset without asking again.
 *
 * Our own client is `no-cache`: it is read off this machine's disk, it changes
 * whenever somebody edits it, and a stale board on a LAN box is worse than a
 * revalidation request that costs nothing. `client/vendor/` is the opposite —
 * a pinned third-party library whose bytes never change under a given name, and
 * three-quarters of a megabyte of it. Revalidating that on every page load is
 * three-quarters of a megabyte of nothing happening.
 */
function cacheControlFor(rel: string): string {
  const unix = rel.split(SEPARATOR).join("/");
  return unix.startsWith("client/vendor/") ? "public, max-age=31536000, immutable" : "no-cache";
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
  if (!rel || rel.startsWith("..")) return null;
  const top = rel.split(/[\\/]/)[0];
  if (!SERVED_DIRS.includes(top)) return null;
  if (!SERVED_EXTENSIONS.has(extname(rel).toLowerCase())) return null;

  const full = join(ROOT, rel);
  // Belt and braces against traversal: the resolved path must stay under ROOT.
  if (!resolve(full).startsWith(ROOT + SEPARATOR)) return null;

  try {
    const file = await Deno.open(full, { read: true });
    const stat = await file.stat();
    if (!stat.isFile) {
      file.close();
      return null;
    }
    const type = contentType(extname(full)) ?? "application/octet-stream";
    return new Response(file.readable, {
      headers: {
        "content-type": type,
        "cache-control": cacheControlFor(rel),
      },
    });
  } catch {
    return null;
  }
}

let indexHtml: string | null = null;
async function serveIndex(): Promise<Response> {
  if (indexHtml === null) {
    indexHtml = await Deno.readTextFile(join(ROOT, "client", "index.html"));
  }
  return new Response(indexHtml, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

async function route(req: Request, remote: string): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 400 });
    }
    return handleUpgrade(req, remote);
  }

  if (url.pathname === "/healthz") {
    return Response.json({ ok: true, rooms: registry.size, sessions: sessions.size });
  }

  if (url.pathname === "/api/info") {
    return Response.json({
      ranker: ranker.stats(),
      wordSources: wordSourceStatuses(ranker),
      aiClues: hasClaude,
      // Shares a dependency with clues but not a switch: the assistant is a
      // per-player companion, not a room setting, and the UI treats it as such.
      assistant: hasAssistant,
      limits: LIMITS,
      rooms: registry.size,
      // The boards that ship are always available: unlike a word source, a board
      // depends on no pack and no model, so there is no status to report and
      // nothing that can be unavailable. Sent here so the setup screen can draw
      // the picker before anybody has a room to be told about them from.
      monoMaps: mapSummaries(),
    });
  }

  // Deep links: /r/AU922U opens the app pointed at that room.
  if (url.pathname === "/" || /^\/r\/[A-Za-z0-9]{1,12}\/?$/.test(url.pathname)) {
    return await serveIndex();
  }

  const asset = await serveStatic(url.pathname);
  if (asset) return asset;

  return new Response("not found", { status: 404 });
}

/**
 * Static assets are the overwhelming majority of requests and say nothing — one
 * page load is a dozen of them. They drop to debug so the http channel stays a
 * record of what happened rather than what was fetched.
 */
function isRoutine(pathname: string): boolean {
  return pathname.startsWith("/client/") || pathname.startsWith("/shared/") ||
    pathname === "/healthz";
}

async function handler(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
  const startedAt = performance.now();
  const url = new URL(req.url);
  const remote = info.remoteAddr.transport === "tcp" ? info.remoteAddr.hostname : "local";

  let response: Response;
  try {
    response = await route(req, remote);
  } catch (err) {
    // A throwing handler would otherwise become an opaque 500 from Deno with
    // nothing written down anywhere.
    log.error("http", "request failed", err, { method: req.method, path: url.pathname, remote });
    return new Response("internal error", { status: 500 });
  }

  const fields = {
    method: req.method,
    path: url.pathname,
    status: response.status,
    ms: Math.round(performance.now() - startedAt),
    remote,
  };
  // The upgrade is logged by its own open/close pair, so it is not repeated here.
  if (url.pathname === "/ws" && response.status === 101) return response;
  if (response.status >= 500) log.error("http", "request", undefined, fields);
  else if (response.status >= 400) log.warn("http", "request", fields);
  else if (isRoutine(url.pathname)) log.debug("http", "request", fields);
  else log.http("request", fields);
  return response;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function lanAddresses(): string[] {
  try {
    return Deno.networkInterfaces()
      .filter((i) => i.family === "IPv4" && !i.address.startsWith("127."))
      .map((i) => i.address);
  } catch {
    return [];
  }
}

const stats = ranker.stats();
const { port } = config;

/**
 * Record the stop on Ctrl-C, then get out of the way.
 *
 * Everything here is synchronous on purpose. `Deno.serve` installs its own
 * SIGINT/SIGTERM handler that shuts the listener down and exits the process, and
 * that exit will not wait for anything we await — the first version of this
 * logged nothing at all on Ctrl-C for exactly that reason. Handlers run in
 * registration order, so this one is attached before `Deno.serve` and writes its
 * line before the process is taken away.
 */
const attachedSignals = attachSignalHandlers(createShutdownHandler({
  onStop: (signal) => {
    log.service("shutting down", { signal, rooms: registry.size, sessions: sessions.size });
  },
  cleanup: () => {
    registry.stopSweeper();
    for (const session of sessions) {
      try {
        session.socket.close(1001, "server shutting down");
      } catch {
        // Already gone.
      }
    }
  },
  exit: (code) => Deno.exit(code),
}));

Deno.serve({
  port,
  hostname: config.hostname,
  // Deno 2.9 turned automatic response compression off by default (2.8 had it
  // on), which quietly made every page load bigger the day we upgraded. The
  // client is text — JavaScript, CSS, a megabyte of it once the 3D board's
  // library is counted — and it travels over office wi-fi to somebody's phone.
  // Turned back on deliberately, so the default flipping again is not a silent
  // regression a third time.
  automaticCompression: true,
  onListen: () => {
    console.log("\n  CloseWord Party");
    console.log(`  ${"-".repeat(40)}`);
    console.log(
      `  words     ${stats.vocabSize} (${stats.dim}d)${stats.sample ? "  [SAMPLE PACK]" : ""}`,
    );
    for (const source of wordSourceStatuses(ranker)) {
      const label = (WORD_SOURCES[source.key] as { short: string }).short;
      console.log(
        `  ${label.toLowerCase().padEnd(9)} ` +
          `${source.available ? `${source.size} secret words` : "unavailable"}`,
      );
    }
    // "not built in" and "not installed" look identical from the outside and are
    // fixed in completely different places, so the banner tells them apart.
    const noClaudeReason = ai.kind === "off" ? "off (not built in)" : "off (claude CLI not found)";
    console.log(
      `  ai clues  ${
        hasClaude
          ? "available via claude -p"
          : config.claude.mode === "off"
          ? "off (CLOSEWORD_AI_CLUES=off)"
          : noClaudeReason
      }`,
    );
    console.log(
      `  chat      ${
        hasAssistant
          ? `on, ${config.assist.perMinute}/min per player`
          : hasClaude
          ? "off (CLOSEWORD_ASSISTANT=false)"
          : noClaudeReason
      }`,
    );
    // Confirm what the environment actually resolved to, so a stale `.env` shows
    // up here rather than as mystifying behaviour later.
    for (const line of configSummary(ai.kind !== "off")) console.log(`  ${line}`);
    console.log(`\n  On this machine:  http://localhost:${port}`);
    for (const addr of lanAddresses()) {
      console.log(`  On your network:  http://${addr}:${port}`);
    }
    if (stats.sample) {
      console.log(
        "\n  Heads up: running on the synthetic sample pack. Run `deno task ingest`\n" +
          "  for real fastText vectors before a serious game.",
      );
    }
    console.log("");

    log.service("listening", {
      host: config.hostname,
      port,
      signals: attachedSignals.join(",") || "none",
      lan: lanAddresses().join(","),
      words: stats.vocabSize,
      sample: stats.sample,
      clues: hasClaude,
      assistant: hasAssistant,
      logLevel: config.log.level,
    });
  },
}, handler);
