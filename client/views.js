// Screen builders and region updaters.
//
// There are two screens: `landing` and `room`. The room screen is built once and
// then updated region by region, which is what keeps the guess input alive
// (focus, cursor, in-progress text) while snapshots stream in.

import { append, el, fill, formatClock, formatRank, proximityPercent } from "./dom.js";
import {
  DIFFICULTIES,
  effectiveRoundSeconds,
  effectiveTotalRounds,
  FINISH_KEYS,
  FINISH_RULES,
  hintHelpText,
  isAdultSource,
  isBoardMode,
  isSoloMode,
  LIMITS,
  MODE_INFO,
  REACTION_KEYS,
  REACTIONS,
  tierForRank,
  WORD_MODES,
  WORD_SOURCE_KEYS,
  WORD_SOURCES,
} from "/shared/constants.js";
import { EMOJI_GROUPS } from "/shared/emoji.js";
import { formatMoney } from "/shared/monopoly.js";
import { canSpeak } from "./speech.js";
import { CURRENT_RELEASE, RELEASES } from "/shared/changelog.js";

const TIMER_URGENT_MS = 15_000;

/**
 * The one gate on the 18+ word set, and it is a question rather than a lock.
 *
 * There is no server-side switch by design: an admin flag would only move the
 * rude round to a server nobody is watching, while the person who actually knows
 * whether this room wants it is the host standing in it. Both prompts name what
 * changes, because "are you sure?" on its own tells nobody anything.
 */
const ADULT_PROMPT =
  "Switch to the after-dark word set?\n\nSecret words will be anatomy, sex and euphemism — " +
  "cheeky rather than nasty. Everyone in the room can see which set is in play.";

const ADULT_ROOM_PROMPT =
  "Switch this room to the after-dark word set?\n\nEverybody here will be playing it, and the " +
  "room panel will show it. Make sure that is a conversation you have had.";

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

/** "Good morning" / "Good afternoon" / "Good evening", by local clock. */
function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function buildLanding(ctx) {
  const { local, actions } = ctx;
  const root = el("div", { class: "landing" });

  append(root, [
    el("div", { class: "hero" }, [
      el("div", { class: "eyebrow", id: "greeting" }),
      el("h1", { html: "Your team's <em>word</em> workspace." }),
      el("p", {
        class: "lede",
        text: "Everyone hunts the same secret word at once, guided only by how close " +
          `each guess is in meaning. ${WORD_MODES.length} ways to play, ${WORD_SOURCE_KEYS.length} sets ` +
          `of words, up to ${LIMITS.maxPlayers} people in a room.`,
      }),
      el("div", { class: "chips-row", id: "landingChips" }),
      el("div", { class: "hero-actions" }, [newsButton(ctx)]),
    ]),
  ]);

  const nickField = el("div", { class: "field" }, [
    el("label", { for: "nick", text: "Your name" }),
    el("input", {
      id: "nick",
      type: "text",
      maxlength: LIMITS.maxNicknameLength,
      placeholder: "e.g. Duc",
      value: local.nickname,
      autocomplete: "off",
      onInput: (e) => actions.setNickname(e.target.value),
    }),
  ]);

  // --- join -------------------------------------------------------------
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
    el("h2", { text: "Join a room" }),
    el("div", { class: "field" }, [
      el("label", { for: "roomCode", text: "Room code" }),
      codeInput,
    ]),
    el("button", { class: "primary", type: "submit", style: "width:100%", text: "Join" }),
  ]);

  // --- create -----------------------------------------------------------
  const modePick = el("div", { class: "mode-pick", id: "modePick" });
  const renderModes = () => {
    fill(
      modePick,
      WORD_MODES.map((mode) =>
        el("button", {
          type: "button",
          "aria-pressed": String(local.newConfig.mode === mode),
          onClick: () => {
            local.newConfig.mode = mode;
            renderModes();
            freshenForMode();
          },
        }, [
          el("strong", { text: MODE_INFO[mode].label }),
          el("small", { text: MODE_INFO[mode].blurb }),
        ])
      ),
    );
  };
  /**
   * Solo practice has nobody to bring in, so the parts of this form that are
   * about other people go away rather than sit there being inapplicable. Called
   * from renderModes because picking a mode is the only thing that changes it.
   */
  const freshenForMode = () => freshenCreateForm(local);
  renderModes();
  freshenForMode();

  // Word source is independent of mode: any mode can be played with any pool.
  const sourcePick = el("div", { class: "mode-pick", id: "sourcePick" });
  const renderSources = () => {
    const statuses = local.serverInfo?.wordSources ?? [];
    fill(
      sourcePick,
      WORD_SOURCE_KEYS.map((key) => {
        const info = WORD_SOURCES[key];
        const status = statuses.find((s) => s.key === key);
        // Before /api/info lands we optimistically allow everything; the server
        // rejects an unplayable source at start with a clear message anyway.
        const usable = !status || status.available;
        if (!usable && local.newConfig.wordSource === key) {
          local.newConfig.wordSource = "closeword";
        }
        return el("button", {
          type: "button",
          class: isAdultSource(key) ? "adult" : "",
          disabled: !usable,
          "aria-pressed": String(local.newConfig.wordSource === key),
          title: status?.note ?? "",
          onClick: () => {
            // Asked once, here, rather than enforced from the server: a host
            // knows their own room. Declining leaves the previous pick alone.
            if (isAdultSource(key) && !confirm(ADULT_PROMPT)) return;
            local.newConfig.wordSource = key;
            renderSources();
          },
        }, [
          el("strong", { text: info.label }),
          el("small", { text: usable ? info.blurb : status.note }),
        ]);
      }),
    );
  };
  renderSources();
  local.renderSources = renderSources;

  const createCard = el("form", {
    class: "card",
    onSubmit: (e) => {
      e.preventDefault();
      actions.create(local.newConfig);
    },
  }, [
    el("h2", { text: "Start a new room" }),
    el("div", { class: "field" }, [
      el("label", { text: "How you play together" }),
      modePick,
    ]),
    el("div", { class: "field" }, [
      el("label", { text: "Where the secret words come from" }),
      sourcePick,
    ]),
    el("div", { class: "field" }, [
      el("label", { for: "newDiff", text: "Difficulty" }),
      el(
        "select",
        { id: "newDiff", onChange: (e) => (local.newConfig.difficulty = e.target.value) },
        Object.entries(DIFFICULTIES).map(([key, info]) =>
          el("option", {
            value: key,
            selected: local.newConfig.difficulty === key,
            text: info.label,
          })
        ),
      ),
    ]),
    el("div", { class: "field", id: "inviteField" }, [
      el("label", { text: "Bring people in" }),
      el("button", {
        type: "button",
        style: "width:100%",
        text: "Invite people who have the app open",
        onClick: () => actions.openInvitePicker(),
      }),
      el("small", {
        class: "muted tiny-text",
        id: "inviteCount",
        // Same sentence the freshen pass will keep writing, so the first paint
        // and every one after it agree.
        text: inviteQueueNote(local),
      }),
    ]),
    el("button", {
      class: "primary",
      type: "submit",
      style: "width:100%",
      id: "createBtn",
      text: "Create room",
    }),
  ]);

  // Setting up a room is the longer job, so it gets the wider column; joining is
  // one field and sits beside it.
  append(root, [
    el("div", { class: "landing-grid" }, [
      el("div", { class: "stack" }, [createCard]),
      el("div", { class: "stack" }, [
        el("div", { class: "card" }, [nickField]),
        joinCard,
        el("div", { class: "card" }, [
          el("h2", { text: "On this server" }),
          el("p", { class: "muted tiny-text", id: "landingNote", style: "margin:0" }),
          // Who is about, and a way straight in. Filled by updateLanding from the
          // `rooms` reply, which the landing page re-asks for on a slow poll.
          el("div", { id: "inviteAhead", class: "invite-ahead", hidden: true }),
          el("div", { id: "liveRooms", class: "live-rooms" }),
        ]),
      ]),
    ]),
    // The dialogs work on both screens: an invitation can arrive while you are
    // still deciding what kind of room to make.
    el("div", { id: "dialogLayer" }),
  ]);
  return root;
}

/**
 * Copy without the Clipboard API: select the text in a throwaway field and let
 * the browser's own copy command take it. Falls back to showing the link so it
 * can be copied by hand.
 */
function fallbackCopy(url) {
  const field = el("input", { type: "text", value: url, style: "position:fixed;opacity:0" });
  document.body.appendChild(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  field.remove();
  if (!ok) prompt("Copy this link:", url);
}

/**
 * A name plus its badges. The name goes in its own box because it is the part
 * allowed to ellipsize — badges must stay whole and stay beside it.
 *
 * `text` may be a plain string or a prepared node, so a caller that wants the
 * name tinted or clickable can hand one in rather than every caller paying for
 * the option.
 */
function nameLine(text, badges = []) {
  const label = typeof text === "string"
    ? el("span", { class: "label", text })
    : el("span", { class: "label" }, [text]);
  return el("div", { class: "name" }, [label, ...badges]);
}

/**
 * How many rows on a board the player actually guessed.
 *
 * Hints land on the board as rows too, which is what makes them readable, but
 * they are not guesses anybody made. The standings and the journey have always
 * counted it this way; the stage chips and the board header say the same thing
 * so a player never sees two different numbers for the same round.
 */
function guessesMade(board) {
  return board ? board.guesses.filter((g) => !g.hint).length : 0;
}

/** A small glass pill: one number and what it means. */
function statChip(glyph, value, label, title = "") {
  return el("div", { class: "chip-stat", title }, [
    el("span", { class: "glyph", text: glyph }),
    el("div", {}, [
      el("div", { class: "n", text: String(value) }),
      el("div", { class: "k", text: label }),
    ]),
  ]);
}

/**
 * How many people are lined up for a room that does not exist yet.
 *
 * Shared by the landing page and the picker's own footer: one sentence, two
 * places, no chance of them disagreeing.
 */
export function inviteQueueNote(local) {
  const n = local.inviteQueue.size;
  if (!n) return "Nobody lined up yet. They get a knock the moment the room exists.";
  return `${n} lined up — ${
    n === 1 ? "they are" : "they are all"
  } invited the moment the room exists.`;
}

/**
 * Hide what solo practice has no use for, and say what the button will do.
 *
 * A form that quietly ignores half of itself is worse than a shorter form: the
 * invite queue really is dropped when you start a solo room, so leaving the
 * picker visible would be an offer the mode cannot keep.
 */
export function freshenCreateForm(local) {
  const solo = isSoloMode(local.newConfig.mode);
  const inviteField = document.getElementById("inviteField");
  if (inviteField) inviteField.hidden = solo;
  const createBtn = document.getElementById("createBtn");
  if (createBtn) createBtn.textContent = solo ? "Start practising" : "Create room";
}

export function updateLanding(ctx) {
  const { local } = ctx;
  updateDialogs(ctx);
  freshenNewsButton(ctx);
  freshenCreateForm(local);

  const inviteNote = document.getElementById("inviteCount");
  if (inviteNote) {
    inviteNote.textContent = inviteQueueNote(local);
  }

  const greet = document.getElementById("greeting");
  if (greet) {
    const name = local.nickname.trim();
    greet.textContent = name ? `${greeting()}, ${name}` : greeting();
  }

  const note = document.getElementById("landingNote");
  if (!note) return;
  const info = local.serverInfo;
  // `ranker` rather than `info`: the lines below dereference it three times, and
  // this runs on every render — including the one after the socket closes, where
  // a half-populated info would take the whole page down with it.
  if (!info?.ranker) {
    note.textContent = local.serverInfoFailed
      ? "Could not reach the game server. The page is up, but nothing is serving the game."
      : "Checking what this server has loaded…";
    return;
  }
  // Availability arrives with /api/info, after the picker was first drawn.
  local.renderSources?.();

  const chips = document.getElementById("landingChips");
  if (chips) {
    const playable = (info.wordSources ?? []).filter((s) => s.available).length;
    fill(chips, [
      statChip("📚", info.ranker.vocabSize.toLocaleString(), "words ranked"),
      statChip("🎲", `${WORD_MODES.length}`, "ways to play"),
      statChip("🗂️", `${playable}/${WORD_SOURCE_KEYS.length}`, "word sets ready"),
      info.assistant ? statChip("✦", "on", "assistant") : null,
    ]);
  }

  note.textContent = `${info.ranker.vocabSize.toLocaleString()} words loaded` +
    (info.ranker.sample ? " — sample pack, so semantics are synthetic" : "") +
    (info.aiClues ? " · AI clues available" : " · no claude CLI, AI clues off");

  freshenLiveRooms(ctx);
}

/**
 * Who is around, and a way into what they are playing.
 *
 * Kept out of the create/join cards on purpose: this is the answer to "is
 * anything happening?", which is a different question from "make me a room".
 * The list is a live poll rather than part of the snapshot — the landing page is
 * not in a room, so there is no snapshot to put it in.
 */
function freshenLiveRooms(ctx) {
  const { local } = ctx;
  const host = document.getElementById("liveRooms");
  if (!host) return;
  const ahead = document.getElementById("inviteAhead");
  if (ahead) freshenInviteAhead(ctx, ahead);
  const live = local.liveRooms;
  if (!live) {
    fill(host, [el("p", { class: "muted tiny-text", text: "Looking for open rooms…" })]);
    return;
  }

  const others = Math.max(0, live.online - 1);
  const summary = el("p", { class: "muted tiny-text" }, [
    others === 0
      ? "You are the only one here right now."
      : `${others} other browser${others === 1 ? "" : "s"} open${
        live.playing ? `, ${live.playing} in a room` : ", nobody in a room yet"
      }.`,
  ]);

  if (live.rooms.length === 0) {
    fill(host, [
      summary,
      el("p", {
        class: "muted tiny-text",
        text: "No open rooms. Make one and it shows up here for everybody else.",
      }),
    ]);
    return;
  }

  fill(host, [
    summary,
    el(
      "div",
      { class: "room-list" },
      live.rooms.map((room) =>
        el("div", { class: "room-row" }, [
          el("div", { style: "min-width:0" }, [
            el("div", { class: "room-row-top" }, [
              el("b", { class: "mono", text: room.code }),
              el("span", { class: "tag", text: MODE_INFO[room.mode]?.label ?? room.mode }),
              isAdultSource(room.wordSource)
                ? el("span", { class: "tag adult-tag", text: "18+" })
                : null,
            ]),
            el("div", {
              class: "muted tiny-text",
              text: `${room.players} player${room.players === 1 ? "" : "s"} · ${
                phaseWord(room)
              } · ${WORD_SOURCES[room.wordSource]?.short ?? room.wordSource} words`,
            }),
          ]),
          el("button", {
            class: "tiny",
            disabled: !room.joinable,
            text: room.joinable ? "Join" : "full",
            title: room.joinable ? `Join ${room.code}` : "That room is full",
            onClick: () => local.actions.join(room.code),
          }),
        ])
      ),
    ),
  ]);
}

/**
 * "Somebody is building a room for you" — the gap this fills.
 *
 * A room cannot be joined before it exists, so there is nothing to click here.
 * That is exactly why it needs saying: the alternative is a landing page that
 * looks identical whether or not anybody is coming for you, which is how a
 * teammate ends up typing an old room code twice while they wait.
 */
function freshenInviteAhead(ctx, host) {
  const { local } = ctx;
  const ahead = local.inviteAhead;
  host.hidden = !ahead;
  if (!ahead) {
    host.replaceChildren();
    return;
  }
  fill(host, [
    el("span", { class: "spinner-dot" }),
    el("div", { style: "min-width:0" }, [
      el("b", { text: `${ahead.fromNickname} is putting a room together for you.` }),
      el("div", {
        class: "tiny-text",
        text: "Sit tight — the code turns up right here the moment it exists.",
      }),
    ]),
  ]);
}

/** What a room is doing, in words rather than a phase name. */
function phaseWord(room) {
  if (room.phase === "lobby") return "waiting to start";
  if (room.phase === "playing") {
    return room.totalRounds > 1 ? `round ${room.round} of ${room.totalRounds}` : "playing";
  }
  if (room.phase === "roundEnd") return "between rounds";
  return "finished";
}

// ---------------------------------------------------------------------------
// Pieces shared by both screens
// ---------------------------------------------------------------------------

/**
 * "What's new", with a dot until the newest release has been read.
 *
 * The dot is the whole feature: release notes nobody is told about are notes
 * nobody reads. It clears on open, per browser, and never comes back for a
 * release already seen.
 */
function newsButton(ctx, label = "What's new") {
  const button = el("button", {
    id: "newsBtn",
    class: "ghost tiny news",
    onClick: () => ctx.local.actions.openChangelog(),
  }, [
    el("span", { text: label }),
    el("span", { class: "news-dot", "aria-label": "unread" }),
  ]);
  freshenNewsButton(ctx, button);
  return button;
}

/**
 * The dot, on every render.
 *
 * Both screens build their topbar once and patch it afterwards, so the button
 * cannot decide its own state at construction time: opening the notes would
 * store the release but leave the dot sitting there until a reload.
 */
function freshenNewsButton(ctx, button = document.getElementById("newsBtn")) {
  if (!button) return;
  const unread = ctx.local.seenRelease < CURRENT_RELEASE;
  button.classList.toggle("unread", unread);
  button.title = unread ? "New in this release" : "Release notes";
  const dot = button.querySelector(".news-dot");
  if (dot) dot.style.display = unread ? "" : "none";
}

/** The emoji palette, recents first. */
function emojiPanel(ctx) {
  const { local } = ctx;
  const groups = local.emojiRecent.length
    ? [{ key: "recent", label: "Recent", emoji: local.emojiRecent }, ...EMOJI_GROUPS]
    : EMOJI_GROUPS;

  return el("div", { class: "emoji-panel", role: "dialog", "aria-label": "Emoji" }, [
    el("div", { class: "emoji-head" }, [
      el("strong", { class: "tiny-text", text: "EMOJI" }),
      el("span", { class: "spacer" }),
      el("span", {
        class: "muted tiny-text",
        // Worth saying: the palette is a shortcut, not the boundary of what the
        // box accepts.
        text: "or paste any emoji",
      }),
      el("button", {
        class: "ghost tiny",
        title: "Close",
        text: "✕",
        onClick: () => local.actions.toggleEmoji(),
      }),
    ]),
    el(
      "div",
      { class: "emoji-scroll" },
      groups.map((group) =>
        el("div", { class: "emoji-group" }, [
          el("div", { class: "muted tiny-text", text: group.label }),
          el(
            "div",
            { class: "emoji-grid" },
            group.emoji.map((emoji) =>
              el("button", {
                type: "button",
                class: "emoji-cell",
                title: emoji,
                text: emoji,
                onClick: () => local.actions.insertEmoji(emoji),
              })
            ),
          ),
        ])
      ),
    ),
  ]);
}

/**
 * Who else has the app open.
 *
 * In a room, ticking somebody invites them then and there. On the landing page
 * there is no room to invite them into yet, so the ticks are held and fired the
 * moment the room exists.
 */
function invitePicker(ctx) {
  const { local, state } = ctx;
  const picker = local.invitePicker;
  const people = picker.people;
  const inRoom = Boolean(state);

  let body;
  if (people === null) {
    body = el("div", { class: "empty tiny-text", text: "Looking…" });
  } else if (people.length === 0) {
    body = el("div", { class: "empty tiny-text" }, [
      "Nobody else has the app open right now. Send them ",
      el("b", { text: `${location.origin}` }),
      " and they will show up here.",
    ]);
  } else {
    body = el(
      "div",
      { class: "plist" },
      people.map((person) =>
        el("div", { class: "pitem" }, [
          el("span", { class: "pos dot", style: `--who-hue:${hueFor(person.id)}` }),
          el("div", { style: "min-width:0" }, [
            nameLine(el("span", { class: "who", text: person.nickname })),
            el("div", {
              class: "meta",
              text: person.busy ? "in another room" : "on the landing page",
            }),
          ]),
          // In a room the click *is* the invitation, so it is spent and the button
          // goes quiet. On the landing page it is only a plan, so it says so and
          // stays live — a "lined up" you cannot undo is a trap, and an "invited"
          // for somebody who has not been invited yet is a lie.
          el("button", {
            class: `tiny${local.inviteQueue.has(person.id) ? " picked" : ""}`,
            disabled: inRoom && local.inviteQueue.has(person.id),
            text: local.inviteQueue.has(person.id)
              ? (inRoom ? "invited" : "lined up ✓")
              : (inRoom ? "invite" : "add"),
            title: !inRoom && local.inviteQueue.has(person.id)
              ? "Click again to take them off the list"
              : "",
            onClick: () => local.actions.toggleInvitee(person.id),
          }),
        ])
      ),
    );
  }

  return modal({
    title: "Invite someone",
    onClose: () => local.actions.closeInvitePicker(),
    body: [
      el("div", { class: "panel-body" }, [
        el("p", {
          class: "muted tiny-text",
          style: "margin:0",
          text: inRoom
            ? "They get a knock on the door with the room code."
            : "There is no room yet, so nobody can be knocked on yet. Line them up here and they are all invited the second you press Create room.",
        }),
      ]),
      body,
      // The running total, inside the dialog. It used to live only under the
      // Create room button — behind this very modal — so ticking somebody looked
      // like it had done nothing at all.
      inRoom ? null : el("div", { class: "panel-body picker-foot", id: "pickerFoot" }, [
        el("span", { class: "tiny-text", text: inviteQueueNote(local) }),
      ]),
    ],
  });
}

/** A centred dialog with a title bar. Used by everything that is not the drawer. */
function modal({ title, onClose, body, wide = false }) {
  return el("div", { class: "modal-wrap" }, [
    el("div", { class: "j-backdrop", onClick: onClose }),
    el("div", {
      class: `modal panel${wide ? " wide" : ""}`,
      role: "dialog",
      "aria-label": title,
    }, [
      el("header", {}, [
        el("span", { text: title }),
        el("span", { class: "spacer" }),
        el("button", { class: "ghost tiny", title: "Close (Esc)", text: "✕", onClick: onClose }),
      ]),
      el("div", { class: "modal-body" }, body),
    ]),
  ]);
}

/** The release notes. */
function changelogPanel(ctx) {
  return modal({
    title: "What's new",
    wide: true,
    onClose: () => ctx.local.actions.closeChangelog(),
    body: RELEASES.map((release, i) =>
      el("div", { class: "release" }, [
        el("div", { class: "release-head" }, [
          el("strong", { text: release.name }),
          i === 0 ? el("span", { class: "badge solved", text: "latest" }) : null,
          el("span", { class: "spacer" }),
          el("span", { class: "muted tiny-text", text: release.date }),
        ]),
        el("p", { class: "muted tiny-text", style: "margin:0 0 10px", text: release.summary }),
        el(
          "ul",
          { class: "release-list" },
          release.changes.map((change) =>
            el("li", {}, [
              el("b", { text: change.title }),
              el("span", { text: ` — ${change.detail}` }),
            ])
          ),
        ),
      ])
    ),
  });
}

/**
 * The dialogs that stack over everything: an invitation waiting on an answer,
 * somebody asking to watch your round, the invite picker, the release notes.
 *
 * Only one shows at a time, in that order. Questions come before browsing:
 * being asked something and having it buried under a panel you opened yourself
 * is how a request gets ignored by accident.
 */
export function updateDialogs(ctx) {
  const layer = document.getElementById("dialogLayer");
  if (!layer) return;
  const { local } = ctx;

  if (local.invite) {
    fill(layer, [inviteDialog(ctx)]);
    return;
  }
  if (local.journeyAsks.length) {
    fill(layer, [journeyAskDialog(ctx, local.journeyAsks[0])]);
    return;
  }
  if (local.invitePicker) {
    fill(layer, [invitePicker(ctx)]);
    return;
  }
  if (local.changelogOpen) {
    fill(layer, [changelogPanel(ctx)]);
    return;
  }
  layer.replaceChildren();
}

function inviteDialog(ctx) {
  const { local } = ctx;
  const invite = local.invite;
  return modal({
    title: "You have been invited",
    onClose: () => local.actions.declineInvite(),
    body: [
      el("div", { class: "panel-body ask" }, [
        el("p", { class: "ask-line" }, [
          el("span", {
            class: "who",
            style: `--who-hue:${hueFor(invite.fromId)}`,
            text: invite.fromNickname,
          }),
          el("span", { text: " wants you to join the war." }),
        ]),
        el("p", { class: "muted tiny-text" }, [
          "Room ",
          el("b", { text: invite.code }),
          ".",
        ]),
        el("div", { class: "wrap" }, [
          el("button", {
            class: "primary",
            text: "Join",
            onClick: () => local.actions.acceptInvite(),
          }),
          el("button", {
            class: "ghost",
            text: "Ignore",
            onClick: () => local.actions.declineInvite(),
          }),
        ]),
      ]),
    ],
  });
}

function journeyAskDialog(ctx, ask) {
  const { local } = ctx;
  return modal({
    title: "Someone wants a look",
    // Closing without deciding is not an answer, so the X refuses. Silence
    // should default to privacy.
    onClose: () => local.actions.answerJourney(ask.playerId, false),
    body: [
      el("div", { class: "panel-body ask" }, [
        el("p", { class: "ask-line" }, [
          el("span", {
            class: "who",
            style: `--who-hue:${hueFor(ask.playerId)}`,
            text: ask.nickname,
          }),
          el("span", { text: " wants to view your plays." }),
        ]),
        el("p", {
          class: "muted tiny-text",
          text: "They would see the guesses you have made this round, as you make " +
            "them. Only this round, and you can be asked again next one.",
        }),
        el("div", { class: "wrap" }, [
          el("button", {
            class: "primary",
            text: "Approve",
            onClick: () => local.actions.answerJourney(ask.playerId, true),
          }),
          el("button", {
            class: "ghost",
            text: "Reject",
            onClick: () => local.actions.answerJourney(ask.playerId, false),
          }),
        ]),
      ]),
    ],
  });
}

// ---------------------------------------------------------------------------
// Room shell
// ---------------------------------------------------------------------------

/**
 * The bar across the top of any room.
 *
 * Shared by both games rather than written twice: the room code, the connection
 * light, buzz, invite and leave are all about being in a room with people, which
 * is the part the two games have in common. `brand` is the one thing that
 * differs, because the board game is not called CloseWord.
 */
/**
 * The bar across the top of a room, shared by both games.
 *
 * @param labels Overrides for the words on it, so the board game can say them in
 *   Vietnamese. Anything not overridden stays in English rather than falling back
 *   to a blank button.
 * @param extra One button a game may add of its own — the board game puts its
 *   rulebook there, where somebody looking for help looks first.
 */
export function roomTopbar(ctx, brand, labels = {}, extra = null) {
  const { actions } = ctx;
  const say = {
    buzz: "⚡ Buzz",
    buzzTitle: "Buzz everyone in the room",
    inviteTitle: "Invite someone who has the app open",
    themeTitle: "Toggle dark mode",
    news: "What's new",
    leave: "Leave",
    ...labels,
  };
  return el("header", { class: "topbar" }, [
    brand,
    el("div", { class: "code-chip", id: "codeChip" }),
    el("div", { class: "status", id: "status", "data-state": "connecting", text: "connecting" }),
    el("button", {
      class: "ghost tiny",
      id: "buzzBtn",
      title: say.buzzTitle,
      text: say.buzz,
      onClick: () => actions.buzz(),
    }),
    el("button", {
      class: "ghost tiny",
      id: "inviteBtn",
      title: say.inviteTitle,
      text: "+",
      onClick: () => actions.openInvitePicker(),
    }),
    extra,
    newsButton(ctx, say.news),
    el("button", {
      class: "ghost tiny",
      title: say.themeTitle,
      text: "◐",
      onClick: () => actions.toggleTheme(),
    }),
    el("button", { class: "ghost tiny", text: say.leave, onClick: () => actions.leave() }),
  ]);
}

/**
 * The who-is-here column. `updateStandings` fills it, in whichever game.
 * @param {string} title Heading, so the board game can say it in Vietnamese.
 */
export function playersColumn(title) {
  return el("div", { class: "panel side-left" }, [
    el("header", {}, [
      el("span", { id: "standingsTitle", text: title }),
      el("span", { class: "spacer" }),
      el("span", { class: "tiny-text", id: "playerCount" }),
    ]),
    el("div", { class: "panel-body tight", id: "standings" }),
  ]);
}

/**
 * The feed and its chat box. Kept whole and shared because the mention menu,
 * the emoji palette and the blur-close timing are fiddly and there is no reason
 * for the board game to own a second copy of them.
 */
/**
 * Split the one column into two panels: what happened, and what people said.
 *
 * One list of both was unreadable at a board game's pace — a hundred lines of
 * dice and rent an hour, with somebody's question to the table buried three
 * screens up in it. Two panels, each scrolling on its own, and neither can bury
 * the other.
 */
export function feedColumn(ctx, title, placeholder, labels = {}, split = null) {
  const { actions } = ctx;
  const say = { send: "Send", emoji: "Emoji", emojiAria: "Insert an emoji", ...labels };
  const chatInput = el("input", {
    id: "chatInput",
    type: "text",
    placeholder,
    maxlength: LIMITS.maxChatLength,
    autocomplete: "off",
    onInput: () => refreshMentionMenu(ctx),
    onKeyDown: (e) => mentionKeys(ctx, e),
    // Closing on blur rather than on a document click, because the only way to
    // reach the menu is with the keyboard or a click that refocuses the input.
    onBlur: () => setTimeout(() => closeMentionMenu(ctx), 120),
  });

  const chatDock = () =>
    el("div", { class: "chat-dock" }, [
      el("div", { id: "emojiPanel" }),
      el("div", { id: "mentionMenu" }),
      el("form", {
        class: "guess-form",
        onSubmit: (e) => {
          e.preventDefault();
          const text = chatInput.value.trim();
          if (!text) return;
          chatInput.value = "";
          actions.chat(text);
        },
      }, [
        chatInput,
        el("button", {
          type: "button",
          id: "emojiBtn",
          class: "emoji-toggle",
          title: say.emoji,
          "aria-label": say.emojiAria,
          text: "🙂",
          onClick: () => actions.toggleEmoji(),
        }),
        el("button", { type: "submit", text: say.send }),
      ]),
    ]);

  if (split) {
    return el("div", { class: "side-right split-right" }, [
      el("div", { class: "panel feed-panel" }, [
        el("header", { text: title }),
        el("div", { class: "feed", id: "feed" }),
      ]),
      el("div", { class: "panel chat-panel" }, [
        el("header", { text: split.chatTitle ?? "Trò chuyện" }),
        el("div", { class: "feed chat-only", id: "chatFeed" }),
        chatDock(),
      ]),
    ]);
  }

  return el("div", { class: "panel side-right" }, [
    el("header", { text: title }),
    el("div", { class: "feed", id: "feed" }),
    // The palette is a sibling of the form rather than a child, so it can be
    // positioned over the feed without the form's flex layout squashing it.
    chatDock(),
  ]);
}

export function buildRoom(ctx) {
  const { actions, local } = ctx;

  const root = el("div", { style: "display:flex;flex-direction:column;flex:1" });

  const topbar = roomTopbar(
    ctx,
    el("div", { class: "brand", html: "Close<span>Word</span> Party" }),
  );

  // --- centre column ----------------------------------------------------
  const guessInput = el("input", {
    id: "guessInput",
    type: "text",
    placeholder: "type a word…",
    maxlength: LIMITS.maxGuessLength,
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
  });

  const guessForm = el("form", {
    class: "guess-form",
    id: "guessForm",
    onSubmit: (e) => {
      e.preventDefault();
      const word = guessInput.value.trim().toLowerCase();
      if (!word) return;
      guessInput.value = "";
      actions.guess(word);
    },
  }, [
    guessInput,
    el("button", { class: "primary", type: "submit", text: "Guess" }),
    el("button", {
      type: "button",
      id: "hintBtn",
      text: "Hint",
      onClick: () => actions.hint(),
    }),
    el("button", {
      type: "button",
      id: "extraHintBtn",
      class: "buy",
      text: "Extra hint 🍻",
      style: "display:none",
      onClick: () => actions.extraHint(),
    }),
  ]);

  // The workspace read-out: how close you are, and the numbers you glance at
  // between guesses. Its own panel so it survives every stage re-render.
  const hud = el("div", { class: "panel", id: "hud" }, [
    el("div", { class: "panel-body row", style: "gap:16px", id: "hudBody" }),
  ]);

  const centre = el("div", { class: "stage-col" }, [
    hud,
    el("div", { class: "panel", id: "stagePanel" }, [
      el("div", { class: "notice", id: "sampleNotice", style: "display:none" }),
      el("div", { class: "banner", id: "banner" }),
      // Above the guess list, not below it. The list only grows, so an input
      // underneath walks down the page as you play and ends up somewhere
      // different on every guess — exactly when you want it to stay put.
      guessForm,
      el("div", { id: "stage" }),
    ]),
  ]);

  const left = playersColumn("Players");
  const right = feedColumn(ctx, "Room feed", "say something, or @ somebody…");

  append(root, [
    topbar,
    el("div", { class: "room" }, [left, centre, right]),
    // The journey drawer and the dialogs live outside the three columns because
    // they cover them.
    el("div", { id: "journeyLayer" }),
    el("div", { id: "dialogLayer" }),
  ]);
  local.guessInput = guessInput;
  return root;
}

// ---------------------------------------------------------------------------
// Room regions
// ---------------------------------------------------------------------------

export function updateRoom(ctx) {
  const { state, local } = ctx;
  if (!state) return;
  updateTopbar(ctx);
  updateHud(ctx);
  updateBanner(ctx);
  updateStage(ctx);
  updateStandings(ctx);
  updateFeed(ctx);
  updateJourney(ctx);
  updateDialogs(ctx);
  freshenNewsButton(ctx);

  const form = document.getElementById("guessForm");
  const input = document.getElementById("guessInput");
  const hintBtn = document.getElementById("hintBtn");
  const extraBtn = document.getElementById("extraHintBtn");
  const playing = state.phase === "playing";
  const board = state.board;
  const canGuess = playing && board && !board.solved;
  form.style.display = state.phase === "lobby" ? "none" : "flex";
  input.disabled = !canGuess;
  input.placeholder = !playing
    ? "waiting for the next round…"
    : board?.solved
    ? "found it!"
    : "type a word…";
  hintBtn.disabled = !canGuess || (board?.hintsLeft ?? 0) <= 0;
  hintBtn.textContent = board ? `Hint (${board.hintsLeft})` : "Hint";
  // Hints belong to a board, so in teams and co-op clicking spends the shared
  // allowance. Spell that out rather than letting someone find out afterwards.
  hintBtn.title = hintHelpText(
    state.config.mode,
    board?.hintsLeft ?? state.config.hintsPerBoard,
    state.config.hintsPerBoard,
  );

  // Buying a hint only makes sense once the free ones are gone, so the button
  // appears exactly then — before that it would just be a way to waste money.
  const you = state.players.find((p) => p.id === state.you.id);
  const canBuy = playing && board && !board.solved && state.config.extraHints &&
    board.hintsLeft === 0;
  extraBtn.style.display = canBuy ? "" : "none";
  extraBtn.disabled = !canBuy;
  extraBtn.textContent = you?.drinks ? `Extra hint 🍻 ${you.drinks}` : "Extra hint 🍻";
  extraBtn.title = you?.drinks
    ? `One more hint, on your tab. You are ${you.drinks} drink${
      you.drinks === 1 ? "" : "s"
    } deep already.`
    : "One more hint — and you are buying the room a drink.";

  // In practice there is provably nobody to buzz or invite — the server refuses
  // a second player — so these are hidden rather than left permanently greyed.
  const solo = isSoloMode(state.config.mode);
  const buzzBtn = document.getElementById("buzzBtn");
  if (buzzBtn) {
    const others = state.players.filter((p) => p.connected && p.id !== state.you.id).length;
    buzzBtn.hidden = solo;
    buzzBtn.disabled = others === 0;
    buzzBtn.title = others === 0
      ? "Nobody else is here to buzz"
      : `Shake the window of ${others} other player${others === 1 ? "" : "s"}`;
  }
  const inviteBtn = document.getElementById("inviteBtn");
  if (inviteBtn) inviteBtn.hidden = solo;

  const emojiPanelHost = document.getElementById("emojiPanel");
  if (emojiPanelHost) {
    fill(emojiPanelHost, local.emojiOpen ? [emojiPanel(ctx)] : []);
    document.getElementById("emojiBtn")?.setAttribute("aria-expanded", String(local.emojiOpen));
    // The palette opens upwards out of the chat dock, and in the lobby the feed
    // column is short enough that its natural height would run up behind the
    // sticky topbar. CSS cannot see how much room is above, so measure it: the
    // palette scrolls internally, so shrinking it costs nothing but a scrollbar.
    const panel = emojiPanelHost.firstElementChild;
    if (panel) {
      const dock = emojiPanelHost.parentElement.getBoundingClientRect();
      const ceiling = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      const room = dock.top - ceiling - 16;
      panel.style.maxHeight = `${Math.max(140, Math.min(300, room))}px`;
    }
  }

  const notice = document.getElementById("sampleNotice");
  if (state.rankerInfo.sample) {
    notice.style.display = "block";
    notice.textContent = "Running on the synthetic sample pack — ranks come from hand-built word " +
      "clusters, not real embeddings. Run `deno task ingest` for the real thing.";
  } else {
    notice.style.display = "none";
  }

  if (local.autofocus && canGuess) {
    local.autofocus = false;
    input.focus();
  }
}

export function updateTopbar({ state, local }) {
  const board = isBoardMode(state.config.mode);
  const copy = board ? "chép liên kết" : "copy link";
  const copied = board ? "đã chép" : "copied";
  const chip = document.getElementById("codeChip");
  fill(chip, [
    el("b", { text: state.code }),
    el("button", {
      class: "ghost tiny",
      title: board ? "Chép liên kết mời" : "Copy the invite link",
      text: local.copied ? copied : copy,
      onClick: (e) => {
        const url = `${location.origin}/r/${state.code}`;
        const done = () => {
          local.copied = true;
          e.target.textContent = copied;
          setTimeout(() => {
            local.copied = false;
            e.target.textContent = copy;
          }, 1500);
        };
        // navigator.clipboard is secure-context only, so on a plain-http LAN
        // address it is simply absent — the case that matters most here, since
        // sharing the link is how everyone else joins.
        const write = navigator.clipboard?.writeText(url);
        if (write) write.then(done, () => fallbackCopy(url));
        else fallbackCopy(url);
      },
    }),
  ]);

  const status = document.getElementById("status");
  status.dataset.state = local.connection;
  const here = state.players.filter((p) => p.connected).length;
  status.textContent = local.connection === "online"
    ? (board ? `${here} đang chơi` : `${here} online`)
    : local.connection;
}

/**
 * The stat strip above the board.
 *
 * The ring shows how close your best guess is on the same log scale as the guess
 * bars, so "nearly there" looks the same everywhere in the UI. In the lobby there
 * is nothing to be close to yet, so it shows the room's setup instead.
 */
function updateHud(ctx) {
  const { state } = ctx;
  const body = document.getElementById("hudBody");
  if (!body) return;

  const cfg = state.config;
  const source = WORD_SOURCES[cfg.wordSource];

  if (state.phase === "lobby") {
    fill(body, [
      el("div", { class: "chips-row" }, [
        statChip("🎲", MODE_INFO[cfg.mode].label, "mode"),
        statChip("🗂️", source.short, "words"),
        statChip("📈", DIFFICULTIES[cfg.difficulty].label, "difficulty"),
        statChip("🔁", effectiveTotalRounds(cfg), "rounds"),
        isSoloMode(cfg.mode)
          ? statChip(
            "🏅",
            ctx.local.record?.best ?? "—",
            "your best",
            "Fewest guesses you have needed on this word set and difficulty. " +
              "Kept in this browser only.",
          )
          : statChip("👥", state.players.length, "in the room"),
      ]),
    ]);
    return;
  }

  const board = state.board;
  const vocab = state.rankerInfo.vocabSize;
  const best = board?.bestRank ?? null;
  const closeness = best === null ? 0 : proximityPercent(best, vocab);
  const you = state.players.find((p) => p.id === state.you.id);

  fill(body, [
    el("div", {
      class: "ring",
      style: `--p:${closeness}`,
      title: best === null
        ? "No guesses yet"
        : `Best rank ${formatRank(best)} of ${vocab.toLocaleString()} words`,
    }, [
      el("div", { class: "val" }, [
        board?.solved ? "★" : `${closeness}`,
        board?.solved ? null : el("small", { text: "%" }),
      ]),
    ]),
    el("div", { class: "chips-row", style: "flex:1" }, [
      statChip(
        "🎯",
        best === null ? "—" : formatRank(best),
        "best rank",
        "The closest guess on your board so far",
      ),
      statChip("💬", guessesMade(board), "guesses"),
      statChip(
        "💡",
        board?.hintsLeft ?? 0,
        "hints left",
        hintHelpText(cfg.mode, board?.hintsLeft ?? 0, cfg.hintsPerBoard),
      ),
      cfg.mode === "coop"
        ? statChip("⭐", state.standings[0]?.score ?? 0, "room score")
        : statChip("🏅", you?.score ?? 0, "your score"),
      statChip("👥", state.players.filter((p) => p.connected).length, "online"),
    ]),
  ]);
}

function updateBanner({ state, local }) {
  const banner = document.getElementById("banner");
  const mode = MODE_INFO[state.config.mode];
  const parts = [];

  if (state.phase === "lobby") {
    parts.push(
      el("div", { class: "titles" }, [
        el("div", { class: "round-label", text: "Set up the room" }),
        el("div", { class: "muted tiny-text", text: mode.blurb }),
      ]),
    );
  } else {
    const round = state.round;
    parts.push(
      el("div", { class: "titles" }, [
        el("div", {
          class: "round-label",
          text: `Round ${round?.number ?? 1} of ${round?.total ?? 1}`,
        }),
        el("div", { class: "wrap" }, [
          el("span", { class: "badge", text: mode.label }),
          el("span", {
            class: "badge",
            title: WORD_SOURCES[state.config.wordSource].blurb,
            text: `${WORD_SOURCES[state.config.wordSource].short} words`,
          }),
          // The house rules change what a round *is*, so they belong where
          // everyone can see them mid-round, not only in the lobby form.
          state.config.mode !== "coop"
            ? el("span", {
              class: "badge",
              title: FINISH_RULES[state.config.finish]?.blurb ?? "",
              text: FINISH_RULES[state.config.finish]?.label ?? state.config.finish,
            })
            : null,
          state.config.guessLimit > 0
            ? el("span", {
              class: "badge",
              title: `Each board gets ${state.config.guessLimit} guesses this round. ` +
                "Hints are free.",
              text: `${state.config.guessLimit}-guess budget`,
            })
            : null,
        ]),
      ]),
    );
    if (state.phase === "playing" && round?.endsAt) {
      parts.push(el("div", { class: "timer", id: "timer", text: "–:––" }));
    }
  }

  const isHost = state.you.isHost;
  if (state.phase === "lobby") {
    parts.push(
      el("button", {
        class: "primary",
        disabled: !isHost || state.players.length === 0,
        text: isHost ? "Start match" : "Waiting for the host…",
        onClick: () => local.actions.start(),
      }),
    );
  } else if (state.phase === "playing") {
    if (isHost) {
      // The three things a host needs when the room is stuck: cut this round
      // short, call the whole match, or start over from nothing.
      parts.push(
        el("button", {
          class: "ghost",
          title: "Score this round now and move on. Nobody else can find it after this.",
          text: "End round",
          onClick: () => local.actions.endRound(),
        }),
        el("button", {
          class: "ghost",
          title: isSoloMode(state.config.mode)
            ? "End the round and stop practising."
            : "Score this round, then stop the match here.",
          text: isSoloMode(state.config.mode) ? "Finish" : "Stop match",
          onClick: () => local.actions.endMatch(),
        }),
      );
    }
  } else if (state.phase === "roundEnd") {
    parts.push(
      el("button", {
        class: "primary",
        disabled: !isHost,
        text: isSoloMode(state.config.mode)
          ? "Next word"
          : (isHost ? "Next round" : "Waiting for the host…"),
        onClick: () => local.actions.next(),
      }),
      isHost
        ? el("button", {
          class: "ghost",
          title: isSoloMode(state.config.mode)
            ? "Finish practising and see the whole session."
            : "Stop the match here and show the final table.",
          text: isSoloMode(state.config.mode) ? "Finish" : "Stop match",
          onClick: () => local.actions.endMatch(),
        })
        : null,
      isHost ? resetButton(local) : null,
    );
  } else if (state.phase === "matchEnd") {
    parts.push(
      el("button", {
        class: "primary",
        disabled: !isHost,
        text: isHost ? "Back to lobby" : "Match over",
        onClick: () => local.actions.next(),
      }),
      isHost ? resetButton(local) : null,
    );
  }

  fill(banner, parts);
  updateTimer(state, local);
}

/**
 * "Reset room" throws away every score in the room, so it asks first. The only
 * destructive control in the app, and the only one that confirms.
 */
function resetButton(local) {
  return el("button", {
    class: "ghost danger",
    title: "Clear all scores and history, and go back to a fresh lobby.",
    text: "Reset room",
    onClick: () => {
      if (confirm("Clear every score and start fresh from the lobby?")) local.actions.reset();
    },
  });
}

/** Called both on snapshot and on a local 250ms tick, so the clock stays smooth. */
export function updateTimer(state, local) {
  const node = document.getElementById("timer");
  if (!node || !state?.round?.endsAt) return;
  // Correct for clock skew between the player's machine and the server.
  const remaining = state.round.endsAt - (Date.now() - local.clockOffset);
  node.textContent = formatClock(remaining);
  node.classList.toggle("urgent", remaining <= TIMER_URGENT_MS);
}

function updateStage(ctx) {
  const { state } = ctx;
  const stage = document.getElementById("stage");
  if (state.phase === "lobby") {
    fill(stage, lobbyStage(ctx));
  } else if (state.phase === "roundEnd" || state.phase === "matchEnd") {
    fill(stage, [revealStage(ctx), boardRows(ctx)]);
  } else {
    fill(stage, boardRows(ctx));
  }
}

// --- lobby ------------------------------------------------------------------

function lobbyStage(ctx) {
  const { state, local } = ctx;
  const isHost = state.you.isHost;
  const cfg = state.config;
  const set = (patch) => local.actions.config(patch);

  const control = (labelText, node, hint) =>
    el("div", { class: "field" }, [
      el("label", { text: labelText }),
      node,
      hint && el("small", { class: "muted tiny-text", text: hint }),
    ]);

  const modeSelect = el(
    "select",
    { disabled: !isHost, onChange: (e) => set({ mode: e.target.value }) },
    WORD_MODES.map((m) =>
      el("option", { value: m, selected: cfg.mode === m, text: MODE_INFO[m].label })
    ),
  );

  const diffSelect = el(
    "select",
    { disabled: !isHost, onChange: (e) => set({ difficulty: e.target.value }) },
    Object.entries(DIFFICULTIES).map(([key, info]) =>
      el("option", { value: key, selected: cfg.difficulty === key, text: info.label })
    ),
  );

  const sourceStatus = (key) => state.wordSources?.find((s) => s.key === key);
  const sourceSelect = el(
    "select",
    {
      disabled: !isHost,
      onChange: (e) => {
        // In a room the question is sharper than on the create screen, because
        // the answer lands on other people. Declining puts the dropdown back.
        if (isAdultSource(e.target.value) && !confirm(ADULT_ROOM_PROMPT)) {
          e.target.value = cfg.wordSource;
          return;
        }
        set({ wordSource: e.target.value });
      },
    },
    WORD_SOURCE_KEYS.map((key) => {
      const status = sourceStatus(key);
      const available = status ? status.available : true;
      return el("option", {
        value: key,
        selected: cfg.wordSource === key,
        disabled: !available,
        text: available
          ? `${WORD_SOURCES[key].label} (${status?.size?.toLocaleString() ?? "?"} words)`
          : `${WORD_SOURCES[key].label} — unavailable`,
      });
    }),
  );

  const numberInput = (value, min, max, onCommit) =>
    el("input", {
      type: "number",
      min,
      max,
      value,
      disabled: !isHost,
      onChange: (e) => onCommit(Number(e.target.value)),
    });

  const activeSource = sourceStatus(cfg.wordSource);
  const poolSize = activeSource?.size ?? 0;
  const diffWindow = DIFFICULTIES[cfg.difficulty].poolLimit;
  const fields = [
    control("Mode", modeSelect, MODE_INFO[cfg.mode].blurb),
    control("Words", sourceSelect, WORD_SOURCES[cfg.wordSource].blurb),
    control(
      "Difficulty",
      diffSelect,
      // Difficulty slices a prefix of the pool, so on a small themed pool there
      // is no deeper tail to reach for. Say so rather than implying otherwise.
      poolSize > 0 && poolSize <= diffWindow
        ? `This pool has ${poolSize.toLocaleString()} words, so all of them are in play.`
        : `Secrets drawn from the ${diffWindow.toLocaleString()} most common words in the pool.`,
    ),
  ];

  if (cfg.mode !== "race") {
    fields.push(
      control(
        "Rounds",
        numberInput(
          cfg.totalRounds,
          LIMITS.minRounds,
          LIMITS.maxRounds,
          (v) => set({ totalRounds: v }),
        ),
      ),
    );
  }
  if (cfg.mode === "teams") {
    fields.push(
      control(
        "Teams",
        numberInput(cfg.teamCount, LIMITS.minTeams, LIMITS.maxTeams, (v) => set({ teamCount: v })),
      ),
    );
  }
  fields.push(
    control(
      "Round timer (seconds)",
      numberInput(cfg.roundSeconds, 0, LIMITS.maxRoundSeconds, (v) => set({ roundSeconds: v })),
      cfg.mode === "coop"
        ? `Co-op always runs on a clock — currently ${effectiveRoundSeconds(cfg)}s`
        : cfg.roundSeconds === 0
        ? "0 = untimed"
        : null,
    ),
  );
  // House rules. Co-op has exactly one board and solo has exactly one player, so
  // "what happens when somebody finds it" has no second party either way and the
  // whole question is moot — including the grace clock that hangs off it.
  if (cfg.mode !== "coop" && !isSoloMode(cfg.mode)) {
    fields.push(
      control(
        "When someone finds the word",
        el(
          "select",
          { disabled: !isHost, onChange: (e) => set({ finish: e.target.value }) },
          FINISH_KEYS.map((key) =>
            el("option", {
              value: key,
              selected: cfg.finish === key,
              text: FINISH_RULES[key].label,
            })
          ),
        ),
        FINISH_RULES[cfg.finish]?.blurb,
      ),
    );
    if (cfg.finish === "grace") {
      fields.push(
        control(
          "Grace after first finisher (seconds)",
          numberInput(cfg.graceSeconds, 0, 600, (v) => set({ graceSeconds: v })),
          "Stops one slow player holding up the room. 0 = no grace clock.",
        ),
      );
    }
  }
  fields.push(
    control(
      "Guess budget per board",
      numberInput(cfg.guessLimit, 0, LIMITS.maxGuessBudget, (v) => set({ guessLimit: v })),
      cfg.guessLimit === 0
        ? "0 = unlimited. Set one to make every guess cost something."
        : `${cfg.guessLimit} guesses per board per round, then the board is out. ` +
          "Hints are free.",
    ),
  );
  fields.push(
    control(
      cfg.mode === "coop"
        ? "Hints for the room"
        : cfg.mode === "teams"
        ? "Hints per team"
        : "Hints per player",
      numberInput(cfg.hintsPerBoard, 0, 10, (v) => set({ hintsPerBoard: v })),
      hintHelpText(cfg.mode, cfg.hintsPerBoard, cfg.hintsPerBoard),
    ),
  );

  const toggles = el("div", { class: "wrap" }, [
    el("label", { class: "row tiny-text" }, [
      el("input", {
        type: "checkbox",
        checked: cfg.revealOnEnd,
        disabled: !isHost,
        style: "width:auto",
        onChange: (e) => set({ revealOnEnd: e.target.checked }),
      }),
      "Reveal the word at round end",
    ]),
    el("label", { class: "row tiny-text" }, [
      el("input", {
        type: "checkbox",
        checked: cfg.aiClues,
        disabled: !isHost || !local.serverInfo?.aiClues,
        style: "width:auto",
        onChange: (e) => set({ aiClues: e.target.checked }),
      }),
      local.serverInfo?.aiClues
        ? "AI prose clues alongside hints"
        : "AI clues (claude CLI not found on the server)",
    ]),
    el("label", {
      class: "row tiny-text",
      title: "Once the free hints are gone, players can buy more — and the room " +
        "finds out who is buying.",
    }, [
      el("input", {
        type: "checkbox",
        checked: cfg.extraHints,
        disabled: !isHost,
        style: "width:auto",
        onChange: (e) => set({ extraHints: e.target.checked }),
      }),
      "Extra hints, paid for in drinks 🍻",
    ]),
  ]);

  const blocks = [];

  // Above the settings, not below them. Who is on your side is the first thing
  // a team room argues about, and at the bottom of twelve fields nobody found it.
  if (cfg.mode === "teams") blocks.push(teamPicker(ctx));

  blocks.push(
    el("div", { class: "panel-body" }, [
      el("div", { class: "grid2" }, fields),
      toggles,
      !isHost && el("p", { class: "muted tiny-text", text: "Only the host can change settings." }),
    ]),
  );

  // A solo room's code is not shareable — the server turns away anybody who
  // tries it — so offering the link would be a promise the mode breaks. The
  // record line takes its place, since that is the thing practice is scored on.
  const record = ctx.local.record;
  blocks.push(
    el("div", { class: "panel-body", style: "border-top:1px solid var(--border)" }, [
      isSoloMode(cfg.mode)
        ? el("p", {
          class: "muted tiny-text",
          text: record?.played
            ? `${record.solved} of ${record.played} words found on this set${
              record.best === null ? "" : `, best ${record.best} guesses`
            }. Kept in this browser only.`
            : "Nobody else can join this room. Your record is kept in this browser only.",
        })
        : el("p", {
          class: "muted tiny-text",
          html:
            `Share <b>${location.origin}/r/${state.code}</b> or just the code <b>${state.code}</b>.`,
        }),
      el("p", {
        class: "muted tiny-text",
        text: isSoloMode(cfg.mode)
          ? "Practice runs word after word — press Next word when you have had enough of one."
          : `${effectiveTotalRounds(cfg)} round(s) will be played.`,
      }),
    ]),
  );

  return blocks;
}

/**
 * Who is on which side, and how to change it.
 *
 * Everyone can move themselves; the host can move anybody, because the person
 * making an even game of it is usually not the person who has to move. Each
 * member is a chip, and for the host that chip is a button that passes them to
 * the next team — one click per move, which beats a dropdown per player.
 */
function teamPicker(ctx) {
  const { state, local } = ctx;
  const isHost = state.you.isHost;
  const locked = state.phase === "playing";
  const count = state.teams.length;

  const rows = state.teams.map((team) => {
    const members = team.memberIds
      .map((id) => state.players.find((p) => p.id === id))
      .filter(Boolean);
    const mine = state.you.teamId === team.id;

    const chips = members.length
      ? members.map((p) =>
        el("button", {
          class: "member" + (p.id === state.you.id ? " you" : ""),
          text: p.nickname,
          type: "button",
          // Moving somebody is the host's job, and moving yourself is always
          // yours; anything else is not a button at all.
          disabled: locked || !(isHost || p.id === state.you.id),
          title: locked
            ? "Teams are locked while a round is running"
            : `Move ${p.id === state.you.id ? "yourself" : p.nickname} to ${
              teamLabel(state, (team.id + 1) % count)
            }`,
          onClick: () => local.actions.setTeam((team.id + 1) % count, p.id),
        })
      )
      : [el("span", { class: "muted tiny-text", text: "nobody yet" })];

    return el("div", { class: "team-row" + (mine ? " mine" : "") }, [
      el("div", { class: "team-head" }, [
        el("strong", { text: team.name }),
        el("span", { class: "muted tiny-text", text: `${members.length}` }),
        el("span", { class: "spacer" }),
        el("button", {
          class: "tiny",
          text: mine ? "you're here" : "join",
          disabled: mine || locked,
          onClick: () => local.actions.setTeam(team.id),
        }),
      ]),
      el("div", { class: "team-members" }, chips),
    ]);
  });

  const sizes = state.teams.map((t) => t.memberIds.length);
  const uneven = sizes.length > 1 && Math.max(...sizes) - Math.min(...sizes) > 1;

  return el("div", { class: "team-picker" }, [
    el("div", { class: "panel-body spread" }, [
      el("strong", { class: "tiny-text", text: "TEAMS" }),
      el("button", {
        class: "tiny",
        text: "Shuffle",
        disabled: !isHost || locked,
        title: isHost ? "Deal everyone out again at random" : "Only the host can shuffle",
        onClick: () => local.actions.shuffleTeams(),
      }),
    ]),
    el("div", { class: "team-grid" }, rows),
    el("p", {
      class: "muted tiny-text",
      style: "padding:0 var(--pad) var(--pad)",
      text: uneven
        ? `Uneven — ${sizes.join(" v ")}. Tap a name to move them, or shuffle.` +
          (isHost ? "" : " Ask the host if it is not your name.")
        : isHost
        ? "Tap any name to pass them to the next team. Teammates share one board."
        : "Tap your own name to switch sides. Teammates share one board.",
    }),
  ]);
}

function teamLabel(state, teamId) {
  return state.teams.find((t) => t.id === teamId)?.name ?? `Team ${teamId + 1}`;
}

// --- reveal -----------------------------------------------------------------

function revealStage(ctx) {
  const { state } = ctx;
  const round = state.round;
  const secret = round?.secret;
  const board = state.board;

  const lines = [];
  if (secret) {
    lines.push(el("div", { class: "muted tiny-text", text: "The word was" }));
    lines.push(el("div", { class: "secret" }, [
      round.secretIcon
        ? el("span", { class: "sicon", "aria-hidden": "true", text: round.secretIcon })
        : null,
      secret,
      // The answer is the one word everybody wants to hear said properly, and
      // this is the screen where there is time to.
      canSpeak()
        ? el("button", {
          class: "wp-say big",
          type: "button",
          title: `Say "${secret}"`,
          "aria-label": `Say ${secret}`,
          onClick: () => ctx.local.actions.sayWord(secret),
        }, [el("span", { "aria-hidden": "true", text: "🔊" })])
        : null,
    ]));
    if (round?.nearMisses?.length) {
      lines.push(el("div", { class: "near", text: "Closest words:" }));
      lines.push(
        el(
          "div",
          { class: "chips" },
          round.nearMisses.map((w) => el("span", { class: "chip", text: w })),
        ),
      );
    }
  } else {
    lines.push(el("div", { class: "secret", text: "Round over" }));
  }

  if (board) {
    lines.push(
      el("p", {
        class: "muted tiny-text",
        style: "margin-top:14px",
        text: board.solved
          ? `You found it in ${guessesMade(board)} guesses.`
          : `You did not find it — best rank ${board.bestRank ?? "—"} in ${
            guessesMade(board)
          } guesses.`,
      }),
    );
  }

  // Practice is the one mode with something to beat, and this is the only screen
  // you reliably see in it — solo skips the lobby by starting itself, so a record
  // shown only there would be a record nobody reads.
  const record = ctx.local.record;
  if (isSoloMode(state.config.mode) && record) {
    const beaten = board?.solved && record.best !== null && guessesMade(board) <= record.best;
    lines.push(
      el("p", {
        class: "muted tiny-text",
        style: "margin-top:2px",
        text: record.best === null
          ? `${record.played} practised, none found yet. Nothing to beat but yourself.`
          : `${
            beaten ? "New best" : "Best"
          }: ${record.best} guesses · ${record.solved} of ${record.played} found. This browser only.`,
      }),
    );
  }

  return el("div", { class: "reveal" }, lines);
}

// --- board ------------------------------------------------------------------

/**
 * What one word is: how to say it, what part of speech, what it means, and what it
 * is in Vietnamese.
 *
 * Written for somebody playing in their second language, which decides the
 * ordering: the speaker button first because sound is the thing that always works,
 * then the Vietnamese line, then the English gloss. IPA rides next to the
 * speaker — it is a pronunciation aid, not a separate fact.
 *
 * Every state gets a sentence rather than a blank: waiting, no such word, no model
 * on this server, and it broke are four different things to a reader and only one
 * of them is worth trying again.
 */
function wordPanel(ctx, word) {
  const entry = ctx.local.words.get(word) ?? { status: "asking" };
  const note = entry.note;
  const rows = [];

  if (note?.pos) rows.push(el("span", { class: "pos", text: shortPos(note.pos) }));
  if (note?.ipa) rows.push(el("span", { class: "ipa", text: `/${note.ipa}/` }));

  const body = [];
  if (note?.vi) {
    body.push(el("div", { class: "vi" }, [
      // Windows has no flag glyphs, so this degrades to the letters "VN" rather
      // than a box — legible either way, which is why it is a flag and not an
      // image.
      el("span", { class: "flag", title: "Vietnamese", "aria-hidden": "true", text: "🇻🇳" }),
      el("span", { lang: "vi", text: note.vi }),
    ]));
  }
  if (note?.meaning) body.push(el("div", { class: "gloss", text: note.meaning }));

  if (!note) {
    body.push(el("div", { class: "gloss muted" }, [
      entry.status === "asking"
        ? el("span", { class: "wp-wait" }, [
          el("span", { class: "spinner-dot", "aria-hidden": "true" }),
          "looking it up…",
        ])
        : entry.status === "unknown"
        ? "No dictionary entry for this one — the button above still says it."
        : entry.status === "unavailable"
        ? "This server has no `claude` command, so there is nothing to look it up with. The speaker still works."
        : "That lookup did not come back. Close and open this to try again.",
    ]));
  }

  return el("div", { class: "wordpanel" }, [
    el("div", { class: "wp-head" }, [
      canSpeak()
        ? el("button", {
          class: "wp-say",
          type: "button",
          title: `Say "${word}" again`,
          "aria-label": `Say ${word}`,
          onClick: () => ctx.local.actions.sayWord(word),
        }, [el("span", { "aria-hidden": "true", text: "🔊" })])
        : null,
      el("strong", { class: "wp-word", text: word }),
      ...rows,
    ]),
    ...body,
  ]);
}

/**
 * "noun" -> "n." Abbreviated in the panel because the row is narrow, spelled out
 * on the wire because the server should not be choosing an English abbreviation.
 */
function shortPos(pos) {
  return POS_SHORT[pos] ?? pos;
}

const POS_SHORT = {
  noun: "n.",
  verb: "v.",
  adjective: "adj.",
  adverb: "adv.",
  pronoun: "pron.",
  preposition: "prep.",
  conjunction: "conj.",
  interjection: "interj.",
  determiner: "det.",
  abbreviation: "abbr.",
};

function boardRows(ctx) {
  const { state, local } = ctx;
  const board = state.board;
  if (!board) {
    return el("div", { class: "empty", text: "You are not on a board this round." });
  }

  const vocab = state.rankerInfo.vocabSize;
  const sorted = [...board.guesses];
  if (local.sort === "rank") sorted.sort((a, b) => a.rank - b.rank);
  else sorted.sort((a, b) => b.n - a.n);

  const latestN = board.guesses.length ? Math.max(...board.guesses.map((g) => g.n)) : -1;
  const shared = state.config.mode === "teams" || state.config.mode === "coop";

  const header = el("div", {
    class: "panel-body spread",
    style: "border-top:1px solid var(--border)",
  }, [
    el("strong", {
      class: "tiny-text",
      text: `${board.label.toUpperCase()} · ${guessesMade(board)} GUESSES`,
    }),
    el("div", { class: "wrap" }, [
      board.clue && el("span", { class: "badge", title: board.clue, text: "clue ▾" }),
      el("button", {
        class: "tiny",
        text: local.sort === "rank" ? "sorted by rank" : "sorted by newest",
        onClick: () => {
          local.sort = local.sort === "rank" ? "recent" : "rank";
          updateStage(ctx);
        },
      }),
    ]),
  ]);

  const parts = [
    header,
    el("div", { class: "panel-body tiny-text muted", style: "padding-top:0" }, [
      hintHelpText(state.config.mode, board.hintsLeft, state.config.hintsPerBoard),
    ]),
  ];
  if (board.clue) {
    parts.push(
      el("div", { class: "panel-body", style: "padding-top:0" }, [
        el("em", { class: "muted tiny-text", text: `Clue: ${board.clue}` }),
      ]),
    );
  }

  if (sorted.length === 0) {
    parts.push(
      el("div", {
        class: "empty",
        text: shared
          ? "No guesses yet — anyone can start."
          : "No guesses yet. Try something broad, like an everyday noun.",
      }),
    );
  } else {
    parts.push(
      el(
        "div",
        { class: "rows" },
        sorted.flatMap((g) => {
          const tier = tierForRank(g.rank, vocab);
          const row = el("div", {
            class: `grow tier-${tier.key}${g.n === latestN ? " latest" : ""}${
              g.hint ? " is-hint" : ""
            }${local.openWord === g.word ? " opened" : ""}`,
            // Colour is a nice-to-have; the rank and this label carry the meaning.
            title: `${g.word} — rank ${formatRank(g.rank)}, ${tier.label}`,
          }, [
            el("div", { class: "bar", style: `width:${proximityPercent(g.rank, vocab)}%` }),
            el("div", { class: "word" }, [
              // The whole word is the button, so the tap target is the thing you
              // were already looking at rather than a separate icon to hunt for.
              el("button", {
                class: "wordbtn",
                type: "button",
                "aria-expanded": local.openWord === g.word ? "true" : "false",
                title: `Say "${g.word}" and look it up`,
                onClick: () => local.actions.toggleWord(g.word),
              }, [
                g.icon ? el("span", { class: "wicon", "aria-hidden": "true", text: g.icon }) : null,
                el("span", { text: g.word }),
              ]),
              g.hint
                ? el("span", { class: "who", text: "hint" })
                : shared
                ? el("span", { class: "who", text: g.byNickname })
                : null,
            ]),
            el("div", { class: "rank", text: formatRank(g.rank) }),
          ]);
          // Inline rather than a floating popover: a list row already tells you
          // what the panel belongs to, and there is no positioning to get wrong
          // when the list scrolls.
          return local.openWord === g.word ? [row, wordPanel(ctx, g.word)] : [row];
        }),
      ),
    );
  }
  return parts;
}

// --- standings --------------------------------------------------------------

/**
 * The handful of words the shared room chrome says out loud.
 *
 * Two games share these panels and only one of them is in English, so the words
 * on them cannot be literals. Kept to the strings a player actually reads on
 * every row rather than every string in the file: a table that tried to hold the
 * whole UI would be a translation layer, and this is a badge and two buttons.
 */
function chromeWords(state) {
  if (!isBoardMode(state.config.mode)) {
    return {
      host: "host",
      makeHost: "Make host",
      ready: "ready",
      hostTools: "HOST TOOLS",
      kick: (name) => `kick ${name}`,
      roomTotal: "Room total",
      players: "PLAYERS",
    };
  }
  return {
    host: "chủ bàn",
    makeHost: "Cho làm chủ bàn",
    ready: "sẵn sàng",
    hostTools: "QUYỀN CHỦ BÀN",
    kick: (name) => `mời ${name} ra`,
    roomTotal: "Cả bàn",
    players: "NGƯỜI CHƠI",
  };
}

export function updateStandings(ctx) {
  const { state, local } = ctx;
  const title = document.getElementById("standingsTitle");
  const count = document.getElementById("playerCount");
  const list = document.getElementById("standings");

  const mode = state.config.mode;
  const say = chromeWords(state);
  const board = isBoardMode(mode);
  title.textContent = board
    ? (state.phase === "lobby" ? "Người chơi" : "Tài sản")
    : state.phase === "lobby"
    ? "Players"
    : mode === "teams"
    ? "Teams"
    : mode === "coop"
    ? "Score"
    : "Standings";
  // The board game seats eight, not twenty-four, and a lobby that counts up to
  // the wrong ceiling is a lobby that lets a ninth person think they are getting in.
  count.textContent = `${state.players.length}/${
    board ? LIMITS.maxBoardPlayers : LIMITS.maxPlayers
  }`;

  if (state.phase === "lobby" || mode === "coop") {
    fill(list, [
      mode === "coop" && state.phase !== "lobby"
        ? el("div", { class: "pitem" }, [
          el("span", { class: "pos", text: "★" }),
          el("div", {}, [
            nameLine(say.roomTotal),
            el("div", { class: "meta", text: state.standings[0]?.detail ?? "" }),
          ]),
          el("span", { class: "score", text: String(state.standings[0]?.score ?? 0) }),
        ])
        : null,
      el("div", { class: "plist" }, state.players.map((p) => playerRow(ctx, p))),
    ]);
    return;
  }

  if (mode === "teams") {
    fill(list, [
      el(
        "div",
        { class: "plist" },
        state.standings.map((s, i) =>
          el("div", { class: "pitem" }, [
            el("span", { class: "pos", text: String(i + 1) }),
            el("div", {}, [
              nameLine(s.label),
              el("div", { class: "meta", text: s.detail }),
            ]),
            el("span", { class: "score", text: String(s.score) }),
          ])
        ),
      ),
      el("div", { class: "panel-body", style: "border-top:1px solid var(--border)" }, [
        el("strong", { class: "tiny-text muted", text: say.players }),
      ]),
      el("div", { class: "plist" }, state.players.map((p) => playerRow(ctx, p))),
    ]);
    return;
  }

  if (board && state.mono) {
    fill(list, monoStandings(ctx));
    return;
  }

  fill(
    list,
    el(
      "div",
      { class: "plist" },
      state.standings.map((s, i) => {
        const player = state.players.find((p) => p.id === s.key);
        return el("div", {
          class: `pitem${s.key === state.you.id ? " you" : ""}${
            player && !player.connected ? " off" : ""
          }`,
        }, [
          el("span", { class: "pos", text: String(i + 1) }),
          el("div", { style: "min-width:0" }, [
            nameLine(
              personName(ctx, player, s.label),
              [
                // Presence first: whether someone is actually there changes how
                // you read everything else on the row.
                presenceBadge(player),
                player?.isHost ? el("span", { class: "badge host", text: say.host }) : null,
                player?.solved
                  ? el("span", { class: "badge solved", text: `#${player.place}` })
                  : null,
                player ? drinksBadge(player) : null,
              ].filter(Boolean),
            ),
            el("div", { class: "meta", text: s.detail }),
            player ? reactionStrip(ctx, player) : null,
          ]),
          el("span", { class: "score", text: String(s.score) }),
        ]);
      }),
    ),
  );

  // Host tools live under the standings list so they are out of the way.
  if (state.you.isHost) {
    const others = state.players.filter((p) => p.id !== state.you.id);
    if (others.length) {
      append(list, [
        el("div", { class: "panel-body", style: "border-top:1px solid var(--border)" }, [
          el("strong", { class: "tiny-text muted", text: say.hostTools }),
          el(
            "div",
            { class: "wrap", style: "margin-top:6px" },
            others.flatMap((p) => [
              el("button", {
                class: "tiny danger",
                text: say.kick(p.nickname),
                onClick: () => local.actions.kick(p.id),
              }),
            ]),
          ),
        ]),
      ]);
    }
  }
}

/**
 * The table, as a table: who is up, who is next, what everyone is worth.
 *
 * Its own renderer rather than three conditionals inside the word game's, because
 * almost nothing carries over. The board's questions are whose turn it is, how
 * many turns until it is mine, and which colour is which — and the answer to all
 * three is this list.
 */
function monoStandings(ctx) {
  const { state } = ctx;
  const mono = state.mono;
  const unit = mono.map.money.unit;
  const seats = [...mono.players].sort((a, b) => a.order - b.order);
  const turnAt = seats.findIndex((p) => p.id === mono.turnId);

  /**
   * How many turns until this seat comes up.
   *
   * Counted in turns rather than in seats, so a bankrupt player between here and
   * there is not a turn anybody waits for. "Sau 2 lượt" is the one number that
   * tells somebody whether to go and refill their glass.
   */
  const waitFor = (id) => {
    if (id === mono.turnId) return 0;
    const from = turnAt < 0 ? 0 : turnAt;
    let turns = 0;
    for (let step = 1; step <= seats.length; step++) {
      const seat = seats[(from + step) % seats.length];
      if (seat.bankrupt) continue;
      turns++;
      if (seat.id === id) return turns;
    }
    return null;
  };

  const rows = [...mono.players]
    .sort((a, b) => Number(a.bankrupt) - Number(b.bankrupt) || b.net - a.net || a.order - b.order)
    .map((seat) => {
      const player = state.players.find((p) => p.id === seat.id);
      const yours = seat.id === state.you.id;
      const theirTurn = seat.id === mono.turnId;
      const wait = waitFor(seat.id);
      return el("div", {
        class: `pitem seat${yours ? " you" : ""}${theirTurn ? " onturn" : ""}` +
          `${seat.bankrupt ? " bust" : ""}${player && !player.connected ? " off" : ""}`,
        style: `--who-hue:${seat.hue}`,
      }, [
        // The chip is both the colour and the cursor: on their turn it becomes an
        // arrow, so "whose turn is it" is answered by the shape of one element.
        el("span", {
          class: "seat-chip",
          title: theirTurn ? "đang tới lượt" : wait ? `còn ${wait} lượt nữa` : "",
          text: theirTurn ? "▶" : seat.token,
        }),
        el("div", { style: "min-width:0" }, [
          nameLine(
            personName(ctx, player, player?.nickname ?? "—"),
            [
              presenceBadge(player),
              player?.isHost ? el("span", { class: "badge host", text: "host" }) : null,
              player?.auto
                ? el("span", {
                  class: "badge auto",
                  title: "đang để máy chơi hộ",
                  text: "🤖 tự động",
                })
                : null,
              seat.inJail ? el("span", { class: "badge jailed", text: "🚔 tù" }) : null,
              seat.shields > 0
                ? el("span", {
                  class: "badge shield",
                  title: "được miễn tiền thuê lần tới",
                  text: seat.shields > 1 ? `🛡️ ${seat.shields}` : "🛡️",
                })
                : null,
            ].filter(Boolean),
          ),
          el("div", { class: "meta" }, [
            el("span", { text: `💵 ${formatMoney(seat.cash, unit)}` }),
            seat.bankrupt
              ? el("span", { class: "danger-text", text: " · phá sản" })
              : theirTurn
              ? el("span", { class: "turn-now", text: " · đang chơi" })
              : wait
              ? el("span", { class: "muted", text: ` · sau ${wait} lượt` })
              : null,
          ]),
        ]),
        el("span", { class: "score", title: "tổng tài sản", text: formatMoney(seat.net, unit) }),
      ]);
    });

  const watching = state.players.filter((p) => p.spectator);
  return [
    el("div", { class: "plist" }, rows),
    watching.length
      ? el("div", { class: "panel-body tight watchers" }, [
        el("strong", { class: "tiny-text muted", text: `👀 Đang xem (${watching.length})` }),
        el(
          "div",
          { class: "watch-names" },
          watching.map((p) =>
            el("span", {
              class: "who",
              style: `--who-hue:${hueFor(p.id)}`,
              text: p.nickname,
            })
          ),
        ),
      ])
      : null,
  ];
}

/**
 * Online/offline marker.
 *
 * Colour *and* shape, never colour alone — a filled dot and a hollow ring read
 * differently to someone who cannot tell the two hues apart, and the title makes
 * it unambiguous for a screen reader.
 */
/**
 * A player's name, tinted with their colour and clickable to open their journey.
 *
 * A real button rather than a span with an onClick: this is the only way into
 * the journey view, so it has to be reachable by keyboard and announced as an
 * action. Falls back to plain text when there is no player behind the label —
 * team rows in the standings, for instance.
 */
export function personName(ctx, player, label) {
  if (!player) return el("span", { class: "who", text: label });
  return el("button", {
    type: "button",
    class: "who linkish",
    title: `See ${label}'s journey`,
    style: `--who-hue:${hueFor(player.id)}`,
    text: label,
    onClick: () => ctx.local.actions.openJourney(player.id),
  });
}

function presenceBadge(player) {
  const online = player?.connected !== false;
  return el("span", {
    class: `presence ${online ? "on" : "off"}`,
    title: online ? "Online" : "Offline — disconnected",
    "aria-label": online ? "online" : "offline",
    text: online ? "🟢" : "⚪",
  });
}

/**
 * The four throwable buttons, plus whatever has already been thrown.
 *
 * The tally is derived from the per-sender list, so the count and the hover
 * detail cannot disagree. Nothing here ever goes `disabled`: throwing is
 * unlimited by design and the server rate-limits it, so a button that stops
 * working would just look broken. Your own row gets the tallies but no buttons
 * — there is no version of applauding yourself that is funny.
 *
 * On your own row a kind nobody has used is omitted entirely; on somebody else's
 * every kind is offered, because the button is how you discover the reaction
 * exists.
 */
function reactionStrip(ctx, p) {
  const { state, local } = ctx;
  const mine = p.id === state.you.id;
  return el(
    "div",
    { class: "reacts" },
    REACTION_KEYS.map((kind) => {
      const senders = p.reactions?.[kind] ?? [];
      const count = senders.reduce((n, s) => n + s.count, 0);
      const detail = count
        ? `${REACTIONS[kind].label} from ${
          senders.map((s) => (s.count > 1 ? `${s.nickname} ×${s.count}` : s.nickname)).join(", ")
        }`
        : `${REACTIONS[kind].title} — ${p.nickname}`;
      if (mine) {
        // Nothing to click, so it is a read-out rather than a dead button.
        return count
          ? el("span", { class: `react tally ${kind}`, title: detail }, [
            el("span", { text: REACTIONS[kind].glyph }),
            el("span", { class: "n", text: String(count) }),
          ])
          : null;
      }
      return el("button", {
        type: "button",
        class: `react ${kind}${count ? " hot" : ""}`,
        title: detail,
        onClick: () => local.actions.react(p.id, kind),
      }, [
        el("span", { text: REACTIONS[kind].glyph }),
        count ? el("span", { class: "n", text: String(count) }) : null,
      ]);
    }).filter(Boolean),
  );
}

function playerRow(ctx, p) {
  const { state, local } = ctx;
  const say = chromeWords(state);
  const teamName = p.teamId !== null ? state.teams.find((t) => t.id === p.teamId)?.name : null;
  return el("div", {
    class: `pitem${p.id === state.you.id ? " you" : ""}${p.connected ? "" : " off"}`,
    // So a thrown egg can find whose row to land on.
    "data-player": p.id,
  }, [
    // Their colour, not a second connection dot — the presence badge beside the
    // name already says that, and two dots per row said it twice.
    el("span", { class: "pos dot", style: `--who-hue:${hueFor(p.id)}` }),
    el("div", { style: "min-width:0" }, [
      nameLine(
        personName(ctx, p, p.nickname),
        [
          presenceBadge(p),
          p.isHost ? el("span", { class: "badge host", text: say.host }) : null,
          drinksBadge(p),
        ].filter(Boolean),
      ),
      el("div", {
        class: "meta",
        text: teamName ?? (state.phase === "lobby" ? say.ready : `${p.guessCount} guesses`),
      }),
      reactionStrip(ctx, p),
    ]),
    state.you.isHost && p.id !== state.you.id && state.phase === "lobby"
      ? el("button", {
        class: "tiny",
        text: say.host,
        title: say.makeHost,
        onClick: () => local.actions.promote(p.id),
      })
      : el("span", { class: "score", text: state.phase === "lobby" ? "" : String(p.score) }),
  ]);
}

/** What they owe the room, if anything. */
function drinksBadge(p) {
  if (!p.drinks) return null;
  return el("span", {
    class: "badge drinks",
    title: `${p.drinks} extra hint${p.drinks === 1 ? "" : "s"} bought — ${p.drinks} drink${
      p.drinks === 1 ? "" : "s"
    } owed to the room`,
    text: `🍻 ${p.drinks}`,
  });
}

// --- journey ----------------------------------------------------------------

/** "+1:04" since the first step of the round, so the pace is readable. */
function sinceLabel(step, first) {
  const seconds = Math.max(0, Math.round((step.at - first) / 1000));
  const mins = Math.floor(seconds / 60);
  return mins ? `+${mins}:${String(seconds % 60).padStart(2, "0")}` : `+${seconds}s`;
}

/**
 * Whether a player's guesses land on the board this client can see.
 *
 * Only ever your own board, plus everyone who shares it: the whole room in
 * co-op, your teammates in teams. Everybody else guesses somewhere the snapshot
 * does not reach.
 */
function sharesYourBoard(ctx, playerId) {
  const { state } = ctx;
  if (playerId === state.you.id) return true;
  if (state.config.mode === "coop") return true;
  if (state.config.mode !== "teams") return false;
  const them = state.players.find((p) => p.id === playerId);
  const you = state.players.find((p) => p.id === state.you.id);
  return them?.teamId != null && them.teamId === you?.teamId;
}

/**
 * Keep the round in progress honest.
 *
 * A journey arrives as a request/response while the room keeps playing
 * underneath the open drawer, so the live round goes stale between refreshes.
 * Everything needed to fix that is already in the snapshot — the counts are
 * public, and your own board comes down in full — so it is patched from there
 * rather than by re-asking the server after every guess in the room.
 */
function freshenLiveRound(ctx, round, targetId) {
  const { state } = ctx;
  if (state.phase !== "playing" || round.number !== state.round?.number) return round;
  const player = state.players.find((p) => p.id === targetId);
  // Your own board — and, in teams and co-op, the board you share — is the only
  // one the snapshot carries rows for. Somebody else's rows are not in it at all,
  // so patching from here would replace the steps the server sent with nothing;
  // theirs stay as they arrived and app.js re-asks when they fall behind.
  const rows = state.board && sharesYourBoard(ctx, targetId)
    ? state.board.guesses.filter((g) => g.hint || g.byPlayerId === targetId)
    : null;
  return {
    ...round,
    solved: player?.solved ?? round.solved,
    place: player?.place ?? round.place,
    bestRank: player?.bestRank ?? round.bestRank,
    guesses: player?.guessCount ?? round.guesses,
    hints: rows ? rows.filter((g) => g.hint).length : round.hints,
    steps: rows
      ? rows.map((g) => ({ word: g.word, rank: g.rank, at: g.at, hint: g.hint }))
      : round.steps,
  };
}

function journeyRound(ctx, round) {
  const vocab = ctx.state.rankerInfo.vocabSize;
  const facts = [
    round.solved ? `found it${round.place ? ` #${round.place}` : ""}` : "did not find it",
    `${round.guesses} ${round.guesses === 1 ? "guess" : "guesses"}`,
    round.hints ? `${round.hints} hint${round.hints === 1 ? "" : "s"}` : null,
    round.bestRank !== null && !round.solved ? `best ${formatRank(round.bestRank)}` : null,
    round.points ? `+${round.points}` : null,
  ].filter(Boolean);

  const head = el("div", { class: "jr-head" }, [
    el("strong", { text: `Round ${round.number}` }),
    round.secret ? el("span", { class: "badge", text: round.secret }) : null,
    el("span", { class: "muted tiny-text", text: facts.join(" · ") }),
  ]);

  if (round.hidden) {
    return el("div", { class: "jr" }, [
      head,
      el("div", {
        class: "empty tiny-text",
        text: "Their guesses stay private until the round ends.",
      }),
    ]);
  }

  if (!round.steps.length) {
    return el("div", { class: "jr" }, [
      head,
      el("div", { class: "empty tiny-text", text: "No guesses this round." }),
    ]);
  }

  const first = round.steps[0].at;
  const truncated = round.guesses + round.hints - round.steps.length;
  return el("div", { class: "jr" }, [
    head,
    truncated > 0
      ? el("div", {
        class: "muted tiny-text",
        style: "padding:0 14px 6px",
        text: `Showing the last ${round.steps.length} of ${round.guesses + round.hints} rows.`,
      })
      : null,
    el(
      "div",
      { class: "rows" },
      // Oldest first: the point of a journey is the order it happened in.
      round.steps.map((step, i) => {
        const tier = tierForRank(step.rank, vocab);
        return el("div", {
          class: `grow tier-${tier.key}${step.hint ? " is-hint" : ""}`,
          title: `${step.word} — rank ${formatRank(step.rank)}, ${tier.label}`,
        }, [
          el("div", { class: "bar", style: `width:${proximityPercent(step.rank, vocab)}%` }),
          el("div", { class: "word" }, [
            el("span", { class: "step-n", text: String(i + 1) }),
            step.word,
            step.hint ? el("span", { class: "who", text: "hint" }) : null,
            el("span", { class: "who", text: sinceLabel(step, first) }),
          ]),
          el("div", { class: "rank", text: formatRank(step.rank) }),
        ]);
      }),
    ),
  ]);
}

/**
 * One player's whole run, newest round first.
 *
 * Rebuilt from scratch on every snapshot like every other region. The drawer
 * holds no input, so there is nothing to preserve across a redraw.
 */
function updateJourney(ctx) {
  const layer = document.getElementById("journeyLayer");
  if (!layer) return;
  const open = ctx.local.journey;
  if (!open) {
    layer.replaceChildren();
    return;
  }

  const data = open.data;
  const player = ctx.state.players.find((p) => p.id === open.playerId);
  const name = data?.nickname ?? player?.nickname ?? "player";
  const isMine = open.playerId === ctx.state.you.id;

  fill(layer, [
    el("div", {
      class: "j-backdrop",
      onClick: () => ctx.local.actions.closeJourney(),
    }),
    el("div", {
      class: `j-drawer panel${isMine ? "" : " compare"}`,
      role: "dialog",
      "aria-label": `${name}'s journey`,
    }, [
      el("header", {}, [
        el("span", { class: "glyph", text: "🧭" }),
        el("span", {
          class: "who",
          style: `--who-hue:${hueFor(open.playerId)}`,
          text: name,
        }),
        // "· journey" rather than "'s journey": the panel header uppercases its
        // text, and an uppercased possessive reads as a typo.
        el("span", { text: "· journey" }),
        el("span", { class: "spacer" }),
        el("button", {
          class: "ghost tiny",
          title: "Close (Esc)",
          text: "✕",
          onClick: () => ctx.local.actions.closeJourney(),
        }),
      ]),
      // Two columns when looking at somebody else: a path to the word only
      // means anything next to another one. Your own view stays single, because
      // there is nothing to compare it with.
      el("div", { class: "j-panes" }, [
        el("div", { class: "j-pane" }, [
          isMine ? null : el("div", { class: "j-pane-head", text: `${name}'s run` }),
          ...journeyBody(ctx, open, data, player, name),
        ]),
        isMine ? null : el("div", { class: "j-pane mine" }, [
          el("div", { class: "j-pane-head", text: "Yours, for comparison" }),
          ...journeyBody(
            ctx,
            open,
            open.mine,
            ctx.state.players.find((p) => p.id === ctx.state.you.id),
            "you",
          ),
        ]),
      ]),
    ]),
  ]);
}

/** One column of the drawer: the totals strip and the rounds under it. */
function journeyBody(ctx, open, data, player, name) {
  const body = [];
  const isTarget = data?.playerId === open.playerId;
  if (isTarget && open.error) {
    body.push(el("div", { class: "empty", text: open.error }));
  } else if (!data) {
    body.push(el("div", { class: "empty", text: "Loading…" }));
  } else {
    // Totals are recomputed from the freshened rounds rather than taken from the
    // reply, so the header cannot disagree with the rounds printed under it.
    const rounds = data.rounds.map((r) => freshenLiveRound(ctx, r, data.playerId));
    const t = rounds.reduce((acc, r) => ({
      guesses: acc.guesses + r.guesses,
      hints: acc.hints + r.hints,
      solves: acc.solves + (r.solved ? 1 : 0),
      bestRank: r.bestRank !== null && (acc.bestRank === null || r.bestRank < acc.bestRank)
        ? r.bestRank
        : acc.bestRank,
    }), { guesses: 0, hints: 0, solves: 0, bestRank: null });
    const score = player?.score ?? data.totals.score;

    body.push(
      el("div", { class: "panel-body" }, [
        el("div", { class: "chips-row" }, [
          statChip("🏁", rounds.length, "rounds"),
          statChip("🎯", t.solves, "found"),
          statChip("💬", t.guesses, "guesses"),
          statChip("💡", t.hints, "hints"),
          statChip("📈", t.bestRank === null ? "—" : formatRank(t.bestRank), "best rank"),
          statChip("🏅", score, "score"),
        ]),
      ]),
    );
    // Their live round is withheld and they are here to be asked, so offer it.
    // Deliberately a button rather than an automatic request: a message that
    // fires because somebody clicked a name would be a way to pester people.
    if (data.needsApproval) {
      body.push(
        el("div", { class: "panel-body ask-strip" }, [
          el("p", {
            class: "muted tiny-text",
            style: "margin:0 0 8px",
            text: `${name} is still playing this round. You can ask to watch.`,
          }),
          el("button", {
            class: "tiny",
            text: `Ask ${name} to watch`,
            onClick: () => ctx.local.actions.askJourney(open.playerId),
          }),
        ]),
      );
    }

    body.push(
      ...(rounds.length ? [...rounds].reverse().map((r) => journeyRound(ctx, r)) : [el("div", {
        class: "empty",
        text: data.playerId === ctx.state.you.id
          ? "You have not played a round yet."
          : "They have not played a round yet.",
      })]),
    );
  }
  return body;
}

// --- feed -------------------------------------------------------------------

/** A glyph per kind, so the eye can skip to the line it wants. */
const FEED_GLYPHS = {
  join: "👋",
  leave: "🚪",
  solve: "🎯",
  round: "🏁",
  chat: "💬",
  hint: "💡",
  system: "⚙️",
  buzz: "⚡",
  react: "🎁",
  // A board move brings its own glyph — dice, rent, a deed, a bankruptcy — so
  // this is only the fallback for a line that somehow arrived without one.
  mono: "🎲",
};

/**
 * Twelve hues spread around the wheel, each picked to stay legible on both the
 * light and dark surface. Assignment is by hash of the player id rather than by
 * join order, so a person keeps their colour across a reconnect — the whole
 * point is that you learn to recognise it.
 *
 * The same hue tints their name in the players list, so the colour you learn in
 * one place means the same thing in the other.
 */
const NAME_HUES = [8, 32, 52, 96, 140, 168, 190, 212, 246, 272, 300, 330];

/**
 * Colours handed out by something that can guarantee they are all different.
 *
 * The hash below is stable and cheap, and it collides: three people in a room
 * came out as two greens and a red, which is the one thing a player colour must
 * never do. The board game deals one hue per seat, so while a board is on the
 * table its answer wins here — and every single thing that draws a person, from
 * a feed line to a pawn in the 3D scene, follows without knowing why.
 */
let hueOverrides = null;

/** @param {Map<string, number> | null} map */
export function setHueOverrides(map) {
  hueOverrides = map && map.size ? map : null;
}

export function hueFor(key) {
  const override = hueOverrides?.get(String(key));
  if (override !== undefined) return override;
  let hash = 0;
  for (let i = 0; i < String(key).length; i++) {
    hash = (hash * 31 + String(key).charCodeAt(i)) >>> 0;
  }
  return NAME_HUES[hash % NAME_HUES.length];
}

function feedLine(ctx, item) {
  // A line's own glyph wins over the one for its kind. Only the board game sends
  // one, and it is the whole reason a hundred lines of dice and rent stay
  // scannable — by kind they would all be the same die.
  const glyph = item.icon || FEED_GLYPHS[item.kind] || "•";
  const parts = [el("span", { class: "glyph", text: glyph })];
  if (item.actor) {
    // A hue rather than a full colour: lightness and saturation come from the
    // theme, so the same name stays readable in dark mode.
    const hue = `--who-hue:${hueFor(item.playerId ?? item.actor)}`;
    const player = item.playerId ? ctx.state.players.find((p) => p.id === item.playerId) : null;
    parts.push(
      player
        ? el("button", {
          type: "button",
          class: "who linkish",
          title: `See ${player.nickname}'s journey`,
          style: hue,
          text: item.actor,
          onClick: () => ctx.local.actions.openJourney(player.id),
        })
        : el("span", { class: "who", text: item.actor, style: hue }),
    );
  }
  parts.push(el("span", { class: "said" }, mentionParts(ctx, item)));
  const tagged = item.mentions?.includes(ctx.state.you.id) ? " tagged-you" : "";
  return el("div", { class: `item ${item.kind}${tagged}` }, parts);
}

/**
 * Split a line so the `@names` in it can be styled.
 *
 * Built out of the *server's* mention list rather than by hunting for `@`
 * anywhere: it is the server that decided who a line reached, and a browser
 * highlighting a name the server did not resolve would promise a notification
 * nobody got. Names come longest-first for the same reason they do there — "@Duc"
 * inside "@Duc M" must not win.
 *
 * Everything is a text node either way, so a nickname full of punctuation is a
 * cosmetic problem at worst and never markup.
 */
function mentionParts(ctx, item) {
  if (!item.mentions?.length) return [item.text];
  const names = ctx.state.players
    .filter((p) => item.mentions.includes(p.id))
    .map((p) => p.nickname)
    .concat(["all", "room"])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const out = [];
  let rest = item.text;
  // Walk left to right, taking the earliest match on each pass. Anything that
  // matches nothing is emitted verbatim, which is the usual outcome for most of
  // the line.
  while (rest.length) {
    let bestAt = -1;
    let bestName = "";
    for (const name of names) {
      const at = rest.toLowerCase().indexOf(`@${name.toLowerCase()}`);
      if (
        at >= 0 &&
        (bestAt === -1 || at < bestAt || (at === bestAt && name.length > bestName.length))
      ) {
        bestAt = at;
        bestName = name;
      }
    }
    if (bestAt === -1) {
      out.push(rest);
      break;
    }
    if (bestAt > 0) out.push(rest.slice(0, bestAt));
    out.push(el("span", { class: "tag", text: rest.slice(bestAt, bestAt + 1 + bestName.length) }));
    rest = rest.slice(bestAt + 1 + bestName.length);
  }
  return out;
}

// --- the @ menu -------------------------------------------------------------
//
// Deliberately not part of `local`: it is transient interface state that belongs
// to one input, it changes on every keystroke, and putting it through the normal
// render would rebuild the feed each time somebody typed a letter.

/** `{ from, query, names, index }` while the menu is open, else null. */
let mentionState = null;

/**
 * The `@word` the caret is sitting in, or null.
 *
 * Anchored to the caret rather than to the end of the value, so going back to fix
 * a name you typed earlier still offers the menu. The `@` must start a word — an
 * email address in the middle of a sentence should not open a picker.
 */
function mentionQuery(input) {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[\w@]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  // A space ends it: `@Duc M` is handled by matching the full nickname, not by
  // keeping the menu open across a word boundary.
  if (/\s/.test(query)) return null;
  return { from: at, query };
}

function mentionCandidates(ctx, query) {
  const q = query.toLowerCase();
  const names = ctx.state.players
    .filter((p) => p.id !== ctx.state.you.id)
    .map((p) => p.nickname)
    .filter((n) => n.toLowerCase().startsWith(q));
  // `all` last, so the safe choice is never the one under the cursor.
  if ("all".startsWith(q)) names.push("all");
  return names.slice(0, 6);
}

function closeMentionMenu(ctx) {
  if (!mentionState) return;
  mentionState = null;
  const host = document.getElementById("mentionMenu");
  if (host) fill(host, []);
  void ctx;
}

function refreshMentionMenu(ctx) {
  const input = document.getElementById("chatInput");
  const host = document.getElementById("mentionMenu");
  if (!input || !host) return;

  const found = mentionQuery(input);
  const names = found ? mentionCandidates(ctx, found.query) : [];
  if (!found || names.length === 0) return closeMentionMenu(ctx);

  // Keep the highlighted row where it was if it is still in the list, so typing
  // another letter does not move the selection out from under Enter.
  const previous = mentionState?.names[mentionState.index];
  const index = Math.max(0, names.indexOf(previous));
  mentionState = { ...found, names, index };
  drawMentionMenu(ctx);
}

function drawMentionMenu(ctx) {
  const host = document.getElementById("mentionMenu");
  if (!host || !mentionState) return;
  fill(
    host,
    el(
      "div",
      { class: "mention-menu", role: "listbox" },
      mentionState.names.map((name, i) =>
        el("button", {
          type: "button",
          role: "option",
          "aria-selected": i === mentionState.index ? "true" : "false",
          class: `mention-item${i === mentionState.index ? " on" : ""}`,
          // `mousedown`, not click: the input's blur handler would have closed the
          // menu before a click ever landed.
          onMouseDown: (e) => {
            e.preventDefault();
            insertMention(ctx, name);
          },
        }, [
          el("span", {
            class: "pos dot",
            style: `--who-hue:${hueFor(idForNickname(ctx, name) ?? name)}`,
          }),
          el("span", { text: name === "all" ? "all — everybody here" : name }),
        ])
      ),
    ),
  );
}

function idForNickname(ctx, nickname) {
  return ctx.state.players.find((p) => p.nickname === nickname)?.id ?? null;
}

function insertMention(ctx, name) {
  const input = document.getElementById("chatInput");
  if (!input || !mentionState) return;
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, mentionState.from);
  const after = input.value.slice(caret);
  // The trailing space is what makes the next word not part of the name, and it
  // is what everybody expects from every other mention box.
  input.value = `${before}@${name} ${after}`;
  const at = before.length + name.length + 2;
  input.setSelectionRange(at, at);
  closeMentionMenu(ctx);
  input.focus();
}

/**
 * Keys the menu owns while it is open. Everything else falls through to the form,
 * which is what makes Enter still send a message when no menu is showing.
 */
function mentionKeys(ctx, event) {
  if (!mentionState) return;
  const { names, index } = mentionState;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    mentionState.index = (index + step + names.length) % names.length;
    drawMentionMenu(ctx);
    return;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    insertMention(ctx, names[index]);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeMentionMenu(ctx);
  }
}

export function updateFeed(ctx) {
  const chat = document.getElementById("chatFeed");
  // With the two split apart, each list gets only its own half. Talk is `chat`
  // and everything else is the game: one predicate, applied twice.
  const isTalk = (item) => item.kind === "chat";
  paintFeed(ctx, document.getElementById("feed"), chat ? (i) => !isTalk(i) : () => true, "—");
  if (chat) paintFeed(ctx, chat, isTalk, "Chưa ai nói gì.");
}

function paintFeed(ctx, node, keep, empty) {
  if (!node) return;
  const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
  const items = ctx.state.feed.filter(keep);
  fill(
    node,
    items.length
      ? items.map((item) => feedLine(ctx, item))
      : el("div", { class: "muted tiny-text", text: empty }),
  );
  // Only auto-scroll if they were already at the bottom, so reading history works.
  if (nearBottom) node.scrollTop = node.scrollHeight;
}
