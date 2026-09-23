// Being tagged with @, and noticing.
//
// A toast alone is not enough, because the whole reason to tag somebody is that
// they are not looking at the feed. So this does three things at three different
// distances from the screen:
//
//   in the panel   the feed pulses and the tagged line is marked, so when you do
//                  look you can see which line wanted you.
//   in the room    two rising notes. Quieter and shorter than a buzz on purpose:
//                  a buzz is "everybody stop", a mention is "this one is yours".
//   in the taskbar the tab title alternates while the tab is hidden, and stops
//                  the moment you come back. That is the only signal that reaches
//                  somebody who has switched away entirely, and it is what makes
//                  this behave like the chat apps people expect.
//
// No desktop Notification API: it needs a permission prompt, and asking for one
// mid-game to deliver a joke would be a worse trade than a blinking title.

import { blip, motionWanted } from "./audio.js";

const TITLE_INTERVAL_MS = 1100;

let flashTimer = null;
let originalTitle = null;

/** Two rising notes — the "somebody said your name" shape. */
function chime() {
  if (!motionWanted()) return;
  blip({ freq: 784, dur: 0.16, gain: 0.06, type: "sine" });
  blip({ at: 0.13, freq: 1046.5, dur: 0.24, gain: 0.055, type: "sine" });
}

function stopFlashing() {
  if (flashTimer === null) return;
  clearInterval(flashTimer);
  flashTimer = null;
  if (originalTitle !== null) document.title = originalTitle;
  originalTitle = null;
}

/**
 * Alternate the tab title until the tab is looked at again.
 *
 * Pointless while the tab is visible — nobody reads the title of the page they
 * are on — so it only starts when hidden, and `visibilitychange` ends it.
 */
function flashTitle(nickname) {
  if (!document.hidden) return;
  if (flashTimer !== null) return;
  originalTitle = document.title;
  const alert = `💬 ${nickname} tagged you`;
  let on = true;
  document.title = alert;
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? alert : originalTitle ?? alert;
  }, TITLE_INTERVAL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) stopFlashing();
});

/** Pulse the feed panel so the eye lands there rather than hunting for it. */
function pulseFeed() {
  if (!motionWanted()) return;
  const feed = document.getElementById("feed");
  if (!feed) return;
  feed.classList.remove("tagged");
  void feed.offsetWidth;
  feed.classList.add("tagged");
  setTimeout(() => feed.classList.remove("tagged"), 1600);
}

export function receiveMention(nickname) {
  chime();
  pulseFeed();
  flashTitle(nickname);
}
