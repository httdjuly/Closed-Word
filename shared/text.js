// Text handling that survives emoji.
//
// Shared verbatim by the Deno server and the browser, like the rest of shared/,
// because both ends truncate the same strings and disagreeing about where a
// character ends is exactly how mojibake gets stored.
//
// The problem this file exists for: a JavaScript string is UTF-16, so `.length`
// and `.slice()` count *code units*, not characters. Almost every emoji is two
// code units, and the interesting ones are far more — a woman astronaut with a
// skin tone is a person, a modifier, a zero-width joiner and a rocket: seven
// code units for one thing you can see. Slicing that at an arbitrary offset
// leaves a dangling surrogate half, which renders as a replacement box and can
// no longer be repaired. People paste emoji from Windows' picker, from macOS,
// from phone keyboards and from other chat apps, and every one of those can
// produce sequences longer than a naive limit expects.

/**
 * Grapheme segmenter, when the runtime has one.
 *
 * `Intl.Segmenter` is the only thing that knows a family emoji is one
 * character; Deno and every current browser have it. Built once, because
 * constructing a segmenter is not cheap and this runs on every chat line.
 *
 * @type {Intl.Segmenter | null}
 */
const SEGMENTER = (() => {
  try {
    return typeof Intl !== "undefined" && Intl.Segmenter
      ? new Intl.Segmenter("en", { granularity: "grapheme" })
      : null;
  } catch {
    return null;
  }
})();

/**
 * Split into user-perceived characters.
 *
 * Falls back to code points, which is imperfect — it would count a joined
 * family emoji as several — but is never *wrong* in the way code units are: a
 * code point boundary is always a legal place to cut, so the fallback can
 * shorten a sequence without ever producing a broken one.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function graphemes(text) {
  const str = String(text ?? "");
  if (SEGMENTER) return [...SEGMENTER.segment(str)].map((s) => s.segment);
  return Array.from(str);
}

/**
 * How long a string is to the person who typed it. One emoji is 1, whatever it
 * cost to encode.
 *
 * @param {string} text
 * @returns {number}
 */
export function visualLength(text) {
  return graphemes(text).length;
}

/**
 * Truncate without ever splitting a character.
 *
 * @param {string} text
 * @param {number} max Maximum number of user-perceived characters.
 * @returns {string}
 */
export function truncate(text, max) {
  const str = String(text ?? "");
  if (max <= 0) return "";
  // A string whose code-unit length already fits cannot need cutting, and that
  // is the overwhelmingly common case — so the segmenter never runs for it.
  if (str.length <= max) return str;
  const parts = graphemes(str);
  return parts.length <= max ? str : parts.slice(0, max).join("");
}

/**
 * Code point ranges that must never reach the room feed, whatever the source.
 *
 * Declared as numbers and compiled below rather than written as a literal
 * character class: a class full of raw control characters is invisible in a
 * diff and impossible to review, which is precisely the wrong property for the
 * one regex in the codebase that decides what user input may contain.
 *
 * Deliberately *absent*: U+200D (zero-width joiner) and U+FE0F (variation
 * selector-16). Those are the glue holding composed emoji together — stripping
 * them is what turns a pasted family into three separate people and a pasted
 * red heart into a monochrome dingbat. Tab and newline are absent too; the
 * whitespace pass in `cleanText` folds them into spaces instead.
 */
const UNSAFE_RANGES = [
  [0x00, 0x08], // C0 controls before tab
  [0x0b, 0x1f], // C0 controls after newline
  [0x7f, 0x9f], // DEL, and the C1 block some clipboards still emit
  [0x200e, 0x200f], // left-to-right / right-to-left marks
  [0x202a, 0x202e], // bidi embedding and override
  [0x2066, 0x2069], // bidi isolates
];

/**
 * Bidi controls are in that list for the same reason as the C0 block: they are
 * invisible, they are not emoji, and left in a nickname they reorder the text
 * printed after it — so "alice" could render the feed line about her backwards.
 */
const UNSAFE_RE = new RegExp(
  "[" +
    UNSAFE_RANGES
      .map(([lo, hi]) =>
        "\\u" + lo.toString(16).padStart(4, "0") +
        "-\\u" + hi.toString(16).padStart(4, "0")
      )
      .join("") +
    "]",
  "gu",
);

/**
 * Make a user-supplied line safe to store and show, without damaging anything
 * they legitimately typed or pasted.
 *
 * @param {string} raw
 * @param {number} max Maximum length in user-perceived characters.
 * @returns {string}
 */
export function cleanText(raw, max) {
  return truncate(
    String(raw ?? "").replace(UNSAFE_RE, "").replace(/\s+/g, " ").trim(),
    max,
  );
}
