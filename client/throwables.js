// Roses, eggs, escalations and blockers, in flight.
//
// The tally on somebody's row is state; the throw is an event, and the two want
// completely different treatment. A number that ticks from 1 to 2 is something
// you notice next time you look at the panel — which is not what "throw an egg
// at Duc" is asking for. So the arrival gets animated, and the number is just
// what is left over afterwards.
//
// Three things make it land rather than merely move:
//
//   escalation  a lone egg is a plop; the fifth egg from the same person is a
//               barrage from every edge of the screen. Volume, spin, sound and
//               screen shake all read off `count` and `total`, so the room can
//               feel a pile-on building without anybody reading a number.
//   impact      every glyph that lands leaves something behind — yolk and
//               specks, or petals that come apart and fall. Flight alone looks
//               like a slide; the mess is what looks like a hit.
//   asymmetry   being hit is a full-screen event with a stamp and a jolt;
//               throwing is a confirmation; watching is a detail in the corner
//               of the players panel.
//
// Everything here is deliberately DOM-and-CSS: no canvas, no library, no
// requestAnimationFrame loop to leak. Each piece is one absolutely positioned
// element with a CSS animation and a self-removal, so a browser that ignores
// the animation ends up with nothing on screen rather than a pile of stuck
// glyphs.

import { REACTIONS } from "/shared/constants.js";
import { blip, motionWanted, noise } from "./audio.js";
import { fxLayer } from "./fxlayer.js";

const FLIGHT_MS = 820;
/** Fraction of the flight at which a glyph is on the target. Matches fx-throw. */
const IMPACT_AT = 0.72;
const SPLAT_MS = 1500;

/**
 * Hard ceiling on elements the layer may hold at once.
 *
 * A pile-on is the whole point, so the volume is allowed to get silly — but ten
 * people throwing at once must not turn into thousands of nodes on a laptop.
 * Past the cap new pieces are simply not created: the show is already busy
 * enough that nobody can tell one is missing.
 */
const MAX_PIECES = 240;
let live = 0;

/**
 * Where on screen a player is right now, or null if they are not drawn.
 *
 * The players panel is the only place a person has a position, which is also the
 * right place for this to land: it is where the tally lives, so the animation
 * ends pointing at the number it just changed.
 */
function locate(playerId) {
  const row = document.querySelector(`.pitem[data-player="${cssEscape(playerId)}"]`);
  if (!row) return null;
  const box = row.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  return { x: box.left + box.width * 0.72, y: box.top + box.height / 2, row };
}

/**
 * Player ids are our own hex tokens, but they arrive over a socket, so they are
 * attacker-controlled as far as this selector is concerned.
 */
function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * Add one piece to the layer and guarantee it leaves again.
 *
 * `animationend` is the normal exit; the timer is the guarantee. A hidden tab
 * fires no animation events at all, and coming back to a screen of stuck eggs
 * would be a worse bug than missing the throw.
 */
function piece(className, styles, lifeMs) {
  if (live >= MAX_PIECES) return null;
  const node = document.createElement("span");
  node.className = className;
  for (const [key, value] of Object.entries(styles)) {
    if (key.startsWith("--")) node.style.setProperty(key, value);
    else node.style[key] = value;
  }
  live++;
  let gone = false;
  const drop = () => {
    if (gone) return;
    gone = true;
    live--;
    node.remove();
  };
  node.addEventListener("animationend", drop, { once: true });
  setTimeout(drop, lifeMs);
  fxLayer().appendChild(node);
  return node;
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// ---------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------

/**
 * What a landing leaves behind, one glyph's worth.
 *
 * An egg breaks: a yolk that spreads and slumps, with specks flung out of it. A
 * rose comes apart: petals that scatter and fall. An escalation leaves a red
 * flare; a blocker leaves hazard tape and grit. All of them fade rather than
 * vanish, because a mark that disappears on a frame boundary reads as a bug.
 *
 * The shape of each is entirely in CSS, keyed off `fx-mark-<kind>` and
 * `fx-bit-<kind>` — which is why adding a reaction needs no geometry here.
 */
function splat(kind, x, y, scale) {
  const spread = 4 + Math.round(scale * 3);
  piece(`fx-mark fx-mark-${kind}`, {
    "--fx-x": `${x}px`,
    "--fx-y": `${y}px`,
    "--fx-r": `${rand(0, 360)}deg`,
    "--fx-size": `${Math.round(26 * scale)}px`,
  }, SPLAT_MS + 200);
  for (let i = 0; i < spread; i++) {
    const angle = rand(0, Math.PI * 2);
    const reach = rand(14, 46) * scale;
    piece(`fx-bit fx-bit-${kind}`, {
      "--fx-x": `${x}px`,
      "--fx-y": `${y}px`,
      "--fx-dx": `${Math.cos(angle) * reach}px`,
      // Biased downwards: bits fly out and then obey gravity, and symmetric
      // scatter reads as a firework rather than something breaking.
      "--fx-dy": `${Math.sin(angle) * reach * 0.5 + rand(18, 60) * scale}px`,
      "--fx-r": `${rand(-540, 540)}deg`,
      "--fx-size": `${Math.round(rand(5, 11) * scale)}px`,
      animationDelay: `${Math.round(rand(0, 60))}ms`,
    }, SPLAT_MS);
  }
}

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

/**
 * Throw `count` glyphs from one point to another, splatting as each arrives.
 *
 * The spread is applied to the *landing* point rather than the launch point:
 * things thrown at a person should converge on them and scatter on impact, and
 * a fan that narrows looks thrown while a fan that widens looks dropped.
 */
function fling(kind, from, to, count, scale, gap = 55) {
  const glyph = REACTIONS[kind].glyph;
  for (let i = 0; i < count; i++) {
    const fanned = (i - (count - 1) / 2) * (18 + 8 * scale);
    const x1 = to.x + fanned + rand(-10, 10);
    const y1 = to.y + rand(-14, 14) * scale;
    const delay = Math.round(i * gap);
    const size = 22 * scale * rand(0.85, 1.2);
    const origin = typeof from === "function" ? from(i, count) : from;
    const node = piece(`fx fx-${kind}`, {
      "--fx-x0": `${origin.x}px`,
      "--fx-y0": `${origin.y}px`,
      "--fx-x1": `${x1}px`,
      "--fx-y1": `${y1}px`,
      "--fx-lift": `${Math.round(rand(60, 150) * scale)}px`,
      "--fx-spin": `${rand(-1, 1) * 720}deg`,
      fontSize: `${Math.round(size)}px`,
      animationDelay: `${delay}ms`,
    }, FLIGHT_MS + delay + 400);
    if (node) node.textContent = glyph;
    setTimeout(() => splat(kind, x1, y1, scale), delay + FLIGHT_MS * IMPACT_AT);
  }
}

/** Launch points around the edge of the viewport, for a full-screen barrage. */
function fromEdges(i, count) {
  const w = globalThis.innerWidth;
  const h = globalThis.innerHeight;
  // Walk the perimeter rather than picking at random, so a barrage arrives from
  // everywhere instead of clustering by luck.
  const t = ((i + 0.5) / count + rand(-0.04, 0.04) + 1) % 1;
  if (t < 0.5) return { x: w * (t * 2), y: -70 };
  if (t < 0.75) return { x: -70, y: h * ((t - 0.5) * 4) };
  return { x: w + 70, y: h * ((t - 0.75) * 4) };
}

// ---------------------------------------------------------------------------
// Being on the receiving end
// ---------------------------------------------------------------------------

/** Flash the row so the eye is already there when the glyphs land. */
function markRow(row, kind) {
  if (!row) return;
  row.classList.remove(`hit-${kind}`);
  void row.offsetWidth;
  row.classList.add(`hit-${kind}`);
  setTimeout(() => row.classList.remove(`hit-${kind}`), FLIGHT_MS + 300);
}

/** A tint that washes over the whole page — the "something just happened". */
function flash(kind, strength) {
  piece(`fx-flash fx-flash-${kind}`, { "--fx-strength": String(strength) }, 900);
}

/**
 * Knock the page about. Separate from the buzz shake so the two can be told
 * apart: a buzz rattles side to side, a hit shoves and settles.
 *
 * Applied to `#app` rather than `body` because a transform on an ancestor makes
 * it the containing block for `position: fixed` children — jolting the body
 * would drag the effects layer along with it and put every glyph in flight in
 * the wrong place. `#app` is the layer's sibling, so it can be shoved freely.
 */
function jolt(hard) {
  const root = document.getElementById("app") ?? document.body;
  root.classList.remove("hit-jolt", "hit-jolt-hard");
  void root.offsetWidth;
  root.classList.add(hard ? "hit-jolt-hard" : "hit-jolt");
  setTimeout(() => root.classList.remove("hit-jolt", "hit-jolt-hard"), 800);
}

/**
 * The centre-screen stamp: the glyph, huge, with the streak beside it.
 *
 * Only shown to the person being hit, and only once they are being hit
 * repeatedly — a stamp on a single polite rose would be shouting.
 */
function stamp(kind, count) {
  const node = piece(`fx-stamp fx-stamp-${kind}`, {}, 1400);
  if (!node) return;
  node.append(REACTIONS[kind].glyph);
  const tag = document.createElement("b");
  tag.textContent = `×${count}`;
  node.append(tag);
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

/**
 * Each kind has its own noise, because four glyphs are hard to tell apart at the
 * size they fly and the ear is faster than the eye at it.
 *
 * `waves` spreads the percussion over the barrage so twelve eggs sound like
 * twelve eggs, not one very loud one — capped, because past four the ear stops
 * counting and starts wincing.
 */
function sound(kind, waves, loud) {
  const n = Math.min(waves, 4);
  if (kind === "egg") {
    for (let i = 0; i < n; i++) {
      const at = i * 0.075;
      noise({ at, dur: 0.07, gain: 0.16, freq: 2400, q: 1.1, type: "bandpass" });
      noise({ at: at + 0.03, dur: 0.22, gain: 0.14, freq: 240, type: "lowpass" });
    }
    // A low swell under a real pelting, so the pile-on is audible as well as
    // visible.
    if (loud) blip({ freq: 120, slideTo: 60, dur: 0.55, gain: 0.1, type: "sawtooth" });
    return;
  }

  if (kind === "escalated") {
    // A two-tone siren, the interval an alarm actually uses. Square waves,
    // because the point is to be slightly unpleasant.
    for (let i = 0; i < n + 1; i++) {
      const at = i * 0.22;
      blip({ at, freq: 880, slideTo: 660, dur: 0.2, gain: 0.075, type: "square" });
      blip({ at: at + 0.11, freq: 660, slideTo: 880, dur: 0.2, gain: 0.075, type: "square" });
    }
    if (loud) blip({ freq: 220, slideTo: 110, dur: 0.7, gain: 0.08, type: "sawtooth" });
    return;
  }

  if (kind === "blocker") {
    // A dead stop: a klaxon that drops and a thud, like a barrier coming down.
    for (let i = 0; i < n; i++) {
      const at = i * 0.13;
      blip({ at, freq: 300, slideTo: 150, dur: 0.24, gain: 0.1, type: "square" });
      noise({ at: at + 0.05, dur: 0.16, gain: 0.13, freq: 180, type: "lowpass" });
    }
    if (loud) noise({ dur: 0.6, gain: 0.11, freq: 90, type: "lowpass" });
    return;
  }

  const scale = [523.25, 659.25, 783.99, 1046.5];
  for (let i = 0; i < n + 1; i++) {
    blip({
      at: i * 0.07,
      freq: scale[i % scale.length] * (i >= scale.length ? 2 : 1),
      dur: 0.3,
      gain: 0.07,
      type: "sine",
    });
  }
  if (loud) blip({ at: 0.3, freq: 1568, dur: 0.5, gain: 0.05, type: "sine" });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * How many glyphs one throw is worth.
 *
 * `count` is this thrower's streak on this target, `total` is what the target
 * has taken from everybody. Both escalate, so a room ganging up on one person
 * builds even when no individual is spamming.
 */
function volume(kind, count, total, target) {
  // Eggs come by the handful. The work reactions are single objects — a wall of
  // twenty road signs is nonsense, and one landing hard reads as more serious.
  const base = BASE_VOLUME[kind] ?? 4;
  const grown = base + (count - 1) * 2 + Math.floor(total / 4) * 2;
  return Math.min(grown, target ? CAP[kind] ?? 22 : Math.ceil((CAP[kind] ?? 22) / 2));
}

const BASE_VOLUME = { rose: 4, egg: 5, escalated: 3, blocker: 2 };
const CAP = { rose: 22, egg: 22, escalated: 12, blocker: 8 };

/**
 * Somebody threw something at somebody.
 *
 * `youAre` is "target", "thrower" or "bystander", which is most of what decides
 * the presentation. A hidden tab is skipped outright: the timers would be
 * throttled into the wrong order anyway, and there is nobody watching.
 */
export function receiveReaction({ kind, fromId, toId, count = 1, total = 1, youAre }) {
  if (!REACTIONS[kind]) return;
  if (!motionWanted()) return;
  if (document.hidden) return;

  const target = locate(toId);
  const thrower = locate(fromId);
  const centre = { x: globalThis.innerWidth / 2, y: globalThis.innerHeight * 0.42 };
  const hit = youAre === "target";
  const heavy = count >= 3 || total >= 6;
  const n = volume(kind, count, total, hit);

  if (hit) {
    // Full screen. The barrage comes from the edges rather than from the
    // thrower's row: on the receiving end it should feel like it is coming at
    // you from outside the window, not from a list on the right.
    fling(
      kind,
      heavy ? fromEdges : () => ({ x: centre.x + rand(-260, 260), y: -70 }),
      centre,
      n,
      2,
      40,
    );
    flash(kind, heavy ? 1 : 0.55);
    jolt(heavy);
    if (count > 1) stamp(kind, count);
  } else {
    // Off the top of the screen when the thrower is not drawn: things come from
    // somewhere, and starting them at (0, 0) reads as a glitch rather than a throw.
    const from = thrower ?? { x: centre.x, y: -60 };
    fling(kind, from, target ?? centre, n, youAre === "thrower" ? 1.15 : 1);
  }

  markRow(target?.row, kind);
  sound(kind, Math.ceil(n / 3), heavy);
}
