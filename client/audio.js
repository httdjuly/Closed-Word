// The tab's one AudioContext, and the small synth primitives built on it.
//
// Extracted from buzz.js once roses and eggs wanted noises of their own: two
// modules each newing up an AudioContext is two contexts, and browsers cap how
// many a page may hold. Everything here is synthesised rather than shipped as
// audio files, so the page still makes no network request to make a sound.

/**
 * Created on first use, never torn down.
 *
 * Browsers refuse to start a context that no user gesture has unlocked, which
 * matters because these sounds are triggered by *other people* — there is no
 * gesture at the moment one plays. In practice the listener has already clicked
 * their way into a room, which is enough; when it is not, `resume` rejects, we
 * swallow it, and the animation still does its job. A silent effect is a
 * degraded effect, not a broken page.
 *
 * @type {AudioContext | null}
 */
let audio = null;

/** @returns {AudioContext | null} */
export function context() {
  if (audio) return audio;
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Ctor) return null;
  try {
    audio = new Ctor();
  } catch {
    audio = null;
  }
  if (audio && audio.state === "suspended") {
    // Suspended contexts throw on some engines and resolve on others; either way
    // there is nothing useful to do about the failure.
    audio.resume().catch(() => {});
  }
  return audio;
}

/**
 * Whether this browser, and this player, want to be moved around.
 *
 * Lives here rather than in either caller because the motion switch gates sound
 * as well as movement: somebody who has turned the animation off is asking for
 * a quiet page, not a silent-but-still-jumping one.
 */
export function motionWanted() {
  if (document.documentElement.dataset.motion === "off") return false;
  return !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * One pitched blip.
 *
 * `at` is seconds from now. The envelope is always ramped rather than switched:
 * an abrupt start or stop clicks, and a click is what makes a synthesised sound
 * cheap.
 */
export function blip({ at = 0, freq = 660, dur = 0.14, gain = 0.16, type = "triangle", slideTo }) {
  const ctx = context();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.015, dur / 3));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch {
    // An audio failure must never take the page with it.
  }
}

/**
 * A burst of filtered white noise — the crack, the splat, the thud.
 *
 * Percussion out of an oscillator sounds like a tone; percussion out of noise
 * sounds like something hitting something. The buffer is built per call because
 * it is a few thousand samples and only lives as long as the burst.
 */
export function noise({ at = 0, dur = 0.16, gain = 0.2, freq = 1800, q = 0.7, type = "lowpass" }) {
  const ctx = context();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + at;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // Decaying noise rather than flat: a burst that stops at full amplitude
      // sounds like a dropout, and the decay is most of what reads as "impact".
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(amp).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  } catch {
    // As above.
  }
}
