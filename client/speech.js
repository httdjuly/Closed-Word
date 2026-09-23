// Saying a word out loud.
//
// The browser does this natively and has since roughly 2014, so the whole feature
// is thirty lines and needs no server, no network and no model. That is worth
// stating plainly because it is the half of the pronunciation feature that always
// works: the IPA and the Vietnamese gloss come from `claude -p` on the server and
// are absent when it is not installed, but the *sound* is local.
//
// Two things are worth knowing about `speechSynthesis`, both of which caused bugs
// here before they were handled:
//
//   - `getVoices()` is empty on the first call in Chrome. Voices load
//     asynchronously and announce themselves with a `voiceschanged` event, so the
//     first press of the button would otherwise use the wrong language.
//   - an utterance queues rather than interrupts. Pressing the button five times
//     says the word five times, several seconds after you stopped caring, so we
//     cancel before speaking.

/** Cached English voice, once the list has loaded. */
let voice = null;
let voicesReady = false;

function pickVoice() {
  if (!globalThis.speechSynthesis) return null;
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  voicesReady = true;
  // Prefer a local voice: a network voice adds latency to something that should
  // feel like pressing a key, and some of them fail silently offline.
  const english = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  return english.find((v) => v.localService) ?? english[0] ?? voices[0] ?? null;
}

if (globalThis.speechSynthesis) {
  voice = pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", () => {
    voice = pickVoice();
  });
}

/** True when this browser can speak at all, so the button can be left out. */
export function canSpeak() {
  return Boolean(globalThis.speechSynthesis && globalThis.SpeechSynthesisUtterance);
}

/**
 * Say `word` in English.
 *
 * Slightly under normal speed: these are single words being learned rather than
 * prose being skimmed, and the default rate clips the end of short ones.
 */
export function speak(word) {
  if (!canSpeak() || !word) return false;
  if (!voicesReady) voice = pickVoice();
  try {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(word));
    utterance.lang = voice?.lang ?? "en-US";
    if (voice) utterance.voice = voice;
    utterance.rate = 0.9;
    speechSynthesis.speak(utterance);
    return true;
  } catch {
    // A browser that throws here has no working synthesiser; the panel still
    // shows the IPA, so there is nothing to report.
    return false;
  }
}
