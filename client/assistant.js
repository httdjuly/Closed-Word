// The floating assistant: a chat with `claude -p`, and a personalise panel.
//
// Two things live behind one small button because they are the same thing from
// the player's point of view — "make this look calmer" and "which word should I
// guess next" are both just talking to the assistant. The Look tab is the manual
// version of everything the chat can do, which matters because the chat needs a
// `claude` binary on the server and the sliders do not.
//
// Everything here is personal. Preferences and the transcript live in this
// browser's localStorage and are never sent to the room, never stored on the
// server, and never visible to another player.

import { $, append, el, fill } from "./dom.js";
import {
  BACKGROUNDS,
  DENSITIES,
  FONTS,
  LAYOUTS,
  PRESETS,
  RADIUS_RANGE,
  THEME_MODES,
} from "/shared/prefs.js";
import {
  currentMode,
  getPrefs,
  imageToDataUri,
  onPrefsChange,
  prefsForPrompt,
  resetPrefs,
  updatePrefs,
} from "./theme.js";

const TRANSCRIPT_KEY = "closeword.assistant.chat";
/** Enough to keep a conversation going; short enough to stay inside the quota. */
const MAX_TRANSCRIPT = 40;
/** How much of the transcript we hand back to the model for context. */
const CONTEXT_TURNS = 6;

const ACCENTS = [
  { hex: "#c96442", name: "Clay" },
  { hex: "#7c9cff", name: "Periwinkle" },
  { hex: "#3f8f5f", name: "Fern" },
  { hex: "#c2410c", name: "Ember" },
  { hex: "#7c5cbf", name: "Iris" },
  { hex: "#0e7490", name: "Teal" },
  { hex: "#e0518f", name: "Rose" },
  { hex: "#4b5563", name: "Slate" },
];

const SUGGESTIONS = [
  "Make it dark and calm",
  "Something warmer, bigger corners",
  "Give me one column, no distractions",
  "How do I get closer when I'm stuck?",
  "Surprise me with a look",
];

/** @typedef {{ role: "you" | "bot" | "note", text: string, bad?: boolean }} Turn */

/** @type {Turn[]} */
let transcript = [];
let open = false;
let tab = "chat";
let pending = null;
let requestSeq = 0;

let sendMessage = () => false;
let assistantAvailable = false;
let unseen = 0;

// ---------------------------------------------------------------------------
// Transcript storage
// ---------------------------------------------------------------------------

function loadTranscript() {
  try {
    const raw = localStorage.getItem(TRANSCRIPT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.text === "string" && ["you", "bot", "note"].includes(t.role))
      .slice(-MAX_TRANSCRIPT);
  } catch {
    return [];
  }
}

function saveTranscript() {
  try {
    // Notes are UI ephemera (with an undo button that no longer works after a
    // reload), so only the conversation itself is kept.
    const keep = transcript.filter((t) => t.role !== "note").slice(-MAX_TRANSCRIPT);
    localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(keep));
  } catch {
    // Out of quota, most likely because of a custom background. The chat still
    // works for this session.
  }
}

function push(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT * 2) transcript = transcript.slice(-MAX_TRANSCRIPT);
  saveTranscript();
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {(msg: object) => boolean} options.send  send a client message over the socket
 */
export function mountAssistant({ send }) {
  sendMessage = send;
  transcript = loadTranscript();

  const fab = el("button", {
    class: "assistant-fab",
    id: "assistantFab",
    type: "button",
    title: "Assistant — chat and personalise (Shift+A)",
    "aria-expanded": "false",
    "aria-controls": "assistantPanel",
    onClick: () => toggle(),
  }, [el("span", { class: "glyph", text: "✦" })]);

  const panel = el("div", {
    class: "assistant-panel",
    id: "assistantPanel",
    role: "dialog",
    "aria-label": "Assistant",
    hidden: true,
  });

  document.body.append(panel, fab);
  renderPanel();

  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      toggle(false);
      return;
    }
    // Shift+A rather than a bare letter, so it cannot fire mid-word in the
    // guess box — and only when no field has focus.
    if (
      e.key === "A" && e.shiftKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(
        document.activeElement?.tagName ?? "",
      )
    ) {
      e.preventDefault();
      toggle();
    }
  });

  // The Look tab mirrors live preference state, so re-render it when anything
  // changes it — including the chat.
  onPrefsChange(() => {
    if (open && tab === "look") renderPanel();
  });
}

/** Told by app.js once /api/info reports whether the server can reach `claude`. */
export function setAssistantAvailable(available) {
  assistantAvailable = Boolean(available);
  if (open) renderPanel();
}

function toggle(next = !open) {
  open = next;
  const panel = $("assistantPanel");
  const fab = $("assistantFab");
  if (!panel || !fab) return;
  panel.hidden = !open;
  fab.setAttribute("aria-expanded", String(open));
  if (open) {
    unseen = 0;
    renderPanel();
    if (tab === "chat") $("assistantInput")?.focus();
  } else {
    renderFabBadge();
  }
}

function renderFabBadge() {
  const fab = $("assistantFab");
  if (!fab) return;
  fill(fab, [
    el("span", { class: "glyph", text: "✦" }),
    unseen > 0 ? el("span", { class: "dot" }) : null,
  ]);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function renderPanel() {
  const panel = $("assistantPanel");
  if (!panel) return;

  const head = el("div", { class: "assistant-head" }, [
    el("div", { class: "who" }, [
      el("b", { text: "Assistant" }),
      el("small", {
        text: assistantAvailable
          ? "Chat, or tune how your workspace looks"
          : "Personalise your workspace",
      }),
    ]),
    el("button", {
      class: "ghost tiny",
      title: "Close",
      text: "✕",
      onClick: () => toggle(false),
    }),
  ]);

  const tabs = el("div", { class: "assistant-tabs", role: "tablist" }, [
    tabButton("chat", "Chat"),
    tabButton("look", "Look"),
  ]);

  fill(panel, [head, tabs, tab === "chat" ? chatTab() : lookTab()]);
  if (tab === "chat") scrollTranscript();
}

function tabButton(key, label) {
  return el("button", {
    type: "button",
    role: "tab",
    "aria-selected": String(tab === key),
    text: label,
    onClick: () => {
      tab = key;
      renderPanel();
      if (key === "chat") $("assistantInput")?.focus();
    },
  });
}

// --- chat -------------------------------------------------------------------

function chatTab() {
  const body = el("div", { class: "assistant-body", id: "assistantBody" });

  if (transcript.length === 0) {
    append(body, [
      el("div", { class: "msg from-bot" }, [
        assistantAvailable
          ? "Hello. I can restyle your workspace — try “make it dark and calm” — or talk " +
            "about the game while you wait for the next round.\n\nWhatever you change is " +
            "yours alone; nobody else in the room sees it."
          : "The server has no `claude` command available, so I cannot chat right now. " +
            "The Look tab still works — everything I would change, you can change there.",
      ]),
    ]);
  }

  for (const turn of transcript) append(body, [turnNode(turn)]);
  if (pending) {
    append(body, [el("div", { class: "msg from-bot thinking", text: "thinking…" })]);
  }

  const input = el("input", {
    id: "assistantInput",
    type: "text",
    placeholder: assistantAvailable ? "Ask, or describe a look…" : "Chat unavailable",
    maxlength: 500,
    autocomplete: "off",
    disabled: !assistantAvailable || Boolean(pending),
  });

  const form = el("form", {
    class: "guess-form",
    style: "border:0;padding:0",
    onSubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      ask(text);
    },
  }, [
    input,
    el("button", {
      class: "primary",
      type: "submit",
      text: "Send",
      disabled: !assistantAvailable || Boolean(pending),
    }),
  ]);

  const foot = el("div", { class: "assistant-foot" }, [
    assistantAvailable
      ? el(
        "div",
        { class: "suggestions" },
        SUGGESTIONS.map((s) =>
          el("button", {
            type: "button",
            text: s,
            disabled: Boolean(pending),
            onClick: () => ask(s),
          })
        ),
      )
      : null,
    form,
    transcript.length
      ? el("button", {
        class: "ghost tiny",
        style: "justify-self:start",
        text: "Clear this conversation",
        onClick: () => {
          transcript = [];
          saveTranscript();
          renderPanel();
        },
      })
      : null,
  ]);

  return [body, foot];
}

function turnNode(turn) {
  if (turn.role !== "note") {
    return el("div", { class: `msg from-${turn.role}`, text: turn.text });
  }
  return el("div", { class: `msg from-note${turn.bad ? " bad" : ""}` }, [
    el("span", { text: turn.text }),
    turn.undo
      ? el("button", {
        class: "tiny",
        text: "Undo",
        onClick: () => {
          updatePrefs(turn.undo);
          turn.undo = null;
          turn.text = "Reverted.";
          renderPanel();
        },
      })
      : null,
  ]);
}

function scrollTranscript() {
  const body = $("assistantBody");
  if (body) body.scrollTop = body.scrollHeight;
}

function ask(text) {
  if (!assistantAvailable || pending) return;
  const id = `a${++requestSeq}`;
  push({ role: "you", text });
  pending = id;
  // Only the last few turns go along: enough for "a bit darker than that" to
  // mean something, without shipping the whole history on every keystroke.
  const history = transcript
    .filter((t) => t.role !== "note")
    .slice(-CONTEXT_TURNS)
    .map((t) => ({ role: t.role, text: t.text }));

  const ok = sendMessage({ t: "assist", id, text, prefs: prefsForPrompt(), history });
  if (!ok) {
    pending = null;
    push({ role: "note", text: "Not connected — try again in a moment.", bad: true });
  }
  renderPanel();
}

/** Called by app.js for every `assistReply` frame. */
export function handleAssistReply(msg) {
  if (msg.id !== pending) return;
  pending = null;

  if (msg.error) {
    push({ role: "note", text: msg.error, bad: true });
  } else {
    if (msg.text) push({ role: "bot", text: msg.text });
    if (msg.patch) applyFromAssistant(msg.patch);
  }

  if (!open) {
    unseen++;
    renderFabBadge();
  } else {
    renderPanel();
  }
}

/**
 * Apply a look the assistant proposed. The patch was already filtered on the
 * server, but it is validated again here — the browser is the only place that
 * knows the player's current preferences, and a change to the page's appearance
 * should never depend on a single check.
 */
function applyFromAssistant(patch) {
  const before = getPrefs();
  const result = updatePrefs(patch);
  if (result.applied.length === 0) {
    if (result.rejected.length) {
      push({ role: "note", text: "I could not apply that change.", bad: true });
    }
    return;
  }
  const note = {
    role: "note",
    text: `Updated ${describe(result.applied)}.`,
    undo: before,
  };
  transcript.push(note);
  saveTranscript();
}

const FIELD_NAMES = {
  mode: "light/dark",
  accent: "the accent colour",
  background: "the background",
  backgroundColor: "the background colour",
  backgroundImage: "your background image",
  layout: "the layout",
  density: "the spacing",
  font: "the typeface",
  glass: "the glass effect",
  radius: "the corner rounding",
  motion: "animation",
};

function describe(keys) {
  const names = keys.map((k) => FIELD_NAMES[k] ?? k);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// --- look -------------------------------------------------------------------

function lookTab() {
  const prefs = getPrefs();
  const body = el("div", { class: "assistant-body" });

  const set = (patch) => updatePrefs(patch);

  const segment = (value, options, onPick) =>
    el(
      "div",
      { class: "seg" },
      options.map(([key, label]) =>
        el("button", {
          type: "button",
          "aria-pressed": String(value === key),
          text: label,
          onClick: () => onPick(key),
        })
      ),
    );

  append(body, [
    // Presets first: one click to a complete look is the fastest path for
    // someone who just wants it to feel different.
    el("div", { class: "field" }, [
      el("label", { text: "Presets" }),
      el(
        "div",
        { class: "mode-pick" },
        Object.entries(PRESETS).map(([key, preset]) =>
          el("button", {
            type: "button",
            onClick: () => set({ preset: key }),
          }, [
            el("strong", { text: preset.label }),
            el("small", { text: preset.hint }),
          ])
        ),
      ),
    ]),

    el("div", { class: "field" }, [
      el("label", { text: "Theme" }),
      segment(
        prefs.mode,
        THEME_MODES.map((m) => [m, m === "system" ? "Auto" : m === "light" ? "Light" : "Dark"]),
        (mode) => set({ mode }),
      ),
    ]),

    el("div", { class: "field" }, [
      el("label", { text: "Accent" }),
      el("div", { class: "swatches" }, [
        ...ACCENTS.map((a) =>
          el("button", {
            type: "button",
            class: "swatch",
            style: `background:${a.hex}`,
            title: a.name,
            "aria-label": a.name,
            "aria-pressed": String(prefs.accent === a.hex),
            onClick: () => set({ accent: a.hex }),
          })
        ),
        el("input", {
          type: "color",
          value: prefs.accent,
          title: "Any colour you like",
          style: "width:44px;height:30px;padding:2px",
          onInput: (e) => set({ accent: e.target.value }),
        }),
      ]),
    ]),

    el("div", { class: "field" }, [
      el("label", { text: "Background" }),
      el(
        "div",
        { class: "scene-grid" },
        Object.entries(BACKGROUNDS)
          // "custom" gets its own upload control below.
          .filter(([key]) => key !== "custom")
          .map(([key, scene]) =>
            el("button", {
              type: "button",
              class: "scene-swatch",
              "aria-pressed": String(prefs.background === key),
              title: scene.label,
              // Preview the scene as it will look in the current theme.
              style: `background-image:${
                key === "solid" ? "none" : scene[currentMode()] ?? "none"
              };background-color:${key === "solid" ? prefs.backgroundColor : "transparent"}`,
              onClick: () => set({ background: key }),
            }, [el("span", { text: scene.label })])
          ),
      ),
    ]),

    prefs.background === "solid"
      ? el("div", { class: "field" }, [
        el("label", { text: "Background colour" }),
        el("input", {
          type: "color",
          value: prefs.backgroundColor,
          onInput: (e) => set({ backgroundColor: e.target.value }),
        }),
      ])
      : null,

    uploadField(prefs, set),

    el("div", { class: "field" }, [
      el("label", { text: "Layout" }),
      segment(
        prefs.layout,
        LAYOUTS.map((l) => [l, l === "columns" ? "Three up" : l === "focus" ? "Focus" : "Wide"]),
        (layout) => set({ layout }),
      ),
    ]),

    el("div", { class: "field" }, [
      el("label", { text: "Spacing" }),
      segment(
        prefs.density,
        DENSITIES.map((d) => [d, d === "compact" ? "Tight" : d === "cozy" ? "Cosy" : "Roomy"]),
        (density) => set({ density }),
      ),
    ]),

    el("div", { class: "field" }, [
      el("label", { text: "Typeface" }),
      segment(
        prefs.font,
        FONTS.map((f) => [
          f,
          f === "system"
            ? "Default"
            : f === "rounded"
            ? "Rounded"
            : f === "serif"
            ? "Serif"
            : "Mono",
        ]),
        (font) => set({ font }),
      ),
    ]),

    el("div", { class: "field" }, [
      el("label", { text: `Corner rounding — ${prefs.radius}px` }),
      el("input", {
        type: "range",
        min: RADIUS_RANGE.min,
        max: RADIUS_RANGE.max,
        value: prefs.radius,
        onInput: (e) => set({ radius: Number(e.target.value) }),
      }),
    ]),

    el("div", { class: "field" }, [
      el("label", { text: "Effects" }),
      el("div", { class: "wrap" }, [
        el("label", { class: "row tiny-text" }, [
          el("input", {
            type: "checkbox",
            checked: prefs.glass,
            onChange: (e) => set({ glass: e.target.checked }),
          }),
          "Frosted glass",
        ]),
        el("label", { class: "row tiny-text" }, [
          el("input", {
            type: "checkbox",
            checked: prefs.motion,
            onChange: (e) => set({ motion: e.target.checked }),
          }),
          "Animation",
        ]),
      ]),
    ]),

    el("div", { class: "privacy-note" }, [
      el("span", { text: "🔒" }),
      el("span", {
        text: "Your look and this conversation are stored in this browser only. They are " +
          "never sent to the room or saved on the server, so nobody else sees them — and " +
          "clearing your browser data resets them.",
      }),
    ]),

    el("button", {
      class: "ghost tiny",
      style: "justify-self:start",
      text: "Reset to defaults",
      onClick: () => {
        resetPrefs();
        renderPanel();
      },
    }),
  ]);

  return body;
}

function uploadField(prefs, set) {
  const status = el("small", { class: "muted tiny-text" });
  const input = el("input", {
    type: "file",
    accept: "image/png,image/jpeg,image/webp",
    style: "font-size:12px",
    onChange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      status.textContent = "resizing…";
      try {
        const dataUri = await imageToDataUri(file);
        const result = set({ backgroundImage: dataUri, background: "custom" });
        status.textContent = result.applied.includes("backgroundImage")
          ? "Set. It stays on this device."
          : "That image could not be used.";
      } catch {
        status.textContent = "Could not read that image.";
      }
      renderPanel();
    },
  });

  return el("div", { class: "field" }, [
    el("label", { text: "Your own background" }),
    input,
    prefs.backgroundImage
      ? el("div", { class: "wrap" }, [
        el("button", {
          class: "tiny",
          text: prefs.background === "custom" ? "In use" : "Use it",
          disabled: prefs.background === "custom",
          onClick: () => {
            set({ background: "custom" });
            renderPanel();
          },
        }),
        el("button", {
          class: "tiny danger",
          text: "Remove",
          onClick: () => {
            set({ backgroundImage: null, background: "clay" });
            renderPanel();
          },
        }),
      ])
      : null,
    status,
  ]);
}
