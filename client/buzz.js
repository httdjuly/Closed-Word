// The receiving end of a buzz: dim the room, stamp BUZZ across it, shake the
// window and make a noise.
//
// The shake alone was too easy to miss — a window that jumps for half a second
// while you are reading your guess list is something you notice only if you
// happened to be looking at the frame. So a buzz now also greys the whole UI out
// behind one huge word, which is the Yahoo! Messenger behaviour this is
// impersonating: for a moment you cannot do anything else, because that is what
// somebody buzzing you is asking for.
//
// The audio primitives live in audio.js, shared with the throwables — one tab,
// one AudioContext.

import { blip, motionWanted } from "./audio.js";
import { fxLayer } from "./fxlayer.js";

const CARD_MS = 1500;

/**
 * Two short descending blips — the shape of every messenger nudge ever written.
 */
export function playBuzzTone() {
  blip({ at: 0, freq: 660, dur: 0.12 });
  blip({ at: 0.14, freq: 495, dur: 0.12 });
}

/**
 * Shake the page. Class-based so the animation lives in the stylesheet with
 * every other one, and self-clearing so repeated buzzes always restart it.
 *
 * Shakes `#app` rather than `body`: a transform makes the element the containing
 * block for its `position: fixed` descendants, and shaking the body would drag
 * the effects layer — the buzz card, and any egg in flight — along with it.
 */
export function shakeWindow() {
  if (!motionWanted()) return;
  const root = document.getElementById("app") ?? document.body;
  root.classList.remove("buzzing");
  // Force a reflow, or removing and re-adding the class in the same frame is a
  // no-op and a second buzz would do nothing visible.
  void root.offsetWidth;
  root.classList.add("buzzing");
  setTimeout(() => root.classList.remove("buzzing"), 700);
}

/**
 * The card itself: a scrim over the whole app with BUZZ! on top of it.
 *
 * Drawn into the shared effects layer, which is `pointer-events: none`, so the
 * greyout is only ever visual — nobody's click is swallowed by somebody else's
 * joke, and a buzz that arrives mid-sentence cannot eat the keystroke. Only one
 * exists at a time: a second buzz replaces the first rather than stacking two
 * scrims into a darker one.
 */
export function showBuzzCard(nickname, mine) {
  if (!motionWanted()) return;
  document.getElementById("buzzCard")?.remove();
  const card = document.createElement("div");
  card.id = "buzzCard";
  card.className = "buzz-card";

  const word = document.createElement("strong");
  word.textContent = "BUZZ!";
  const who = document.createElement("span");
  who.textContent = mine ? "you buzzed the room" : `${nickname} buzzed the room`;
  card.append(word, who);

  fxLayer().appendChild(card);
  const drop = () => card.remove();
  card.addEventListener("animationend", drop, { once: true });
  // A hidden tab fires no animation events, so the timer is the real guarantee.
  setTimeout(drop, CARD_MS + 400);
}

/** Everything a buzz does on arrival. */
export function receiveBuzz(nickname, mine) {
  showBuzzCard(nickname, mine);
  shakeWindow();
  playBuzzTone();
}
