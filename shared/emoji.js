// The emoji palette offered beside the chat box.
//
// A hand-picked list rather than the full Unicode set, and no external library:
// the whole app is served straight off disk with no build step, and pulling in
// an emoji-data package to render a picker nobody asked to be exhaustive would
// be the largest dependency in the project by an order of magnitude.
//
// Nothing here constrains what you may *send*. The picker is a convenience;
// pasting any emoji from any system works whether or not it appears below, and
// shared/text.js is what makes sure it survives the trip.

/**
 * Categories in the order they appear.
 *
 * Written as space-separated strings rather than arrays of literals purely for
 * legibility: as arrays the formatter puts every emoji on its own line, which
 * turns a glanceable grid into four screens of scrolling. No emoji contains a
 * space, so the split is unambiguous.
 *
 * Keys are stable and recents are stored by the emoji itself, not by index, so
 * this list can be reordered or extended without invalidating anyone's history.
 */
export const EMOJI_GROUPS = [
  {
    key: "reactions",
    label: "Reactions",
    emoji: ("👍 👎 👏 🙌 🙏 🤝 💪 🫡 🔥 ✨ 💯 🎉 " +
      "🎊 🏆 🥇 ⭐ ❤️ 🧡 💛 💚 💙 💜 🖤 💔").split(" "),
  },
  {
    key: "faces",
    label: "Faces",
    emoji: ("😀 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😍 🤩 " +
      "😘 😗 🙃 🤔 🤨 😐 😑 🙄 😏 😴 😪 🤤 " +
      "😭 😤 😡 🤯 😱 😳 🥵 🥶 😬 🫠 🤫 🤭 " +
      "🧐 🤓 😎 🥳").split(" "),
  },
  {
    key: "game",
    label: "In play",
    emoji: ("🎯 🧠 💡 🔍 🧭 🗝️ 🚀 🐢 ⏳ ⌛ ⏰ 🔔 " +
      "📣 🚨 🎲 🃏 🧩 ♟️ 🥁 🎪 🪄 🔮 📈 📉").split(" "),
  },
  {
    key: "social",
    label: "Table manners",
    emoji: ("🌹 🥚 🍺 🍻 🥂 ☕ 🍰 🍕 🍿 🧋 🍩 🫖 " +
      "👋 🤗 😇 😈 🤡 💀 👻 🫶 🤞 🤙 ✌️ 🫰").split(" "),
  },
];

/** Every emoji in the palette, flat. */
export const EMOJI_ALL = EMOJI_GROUPS.flatMap((g) => g.emoji);

/** How many recently-used emoji the picker remembers, per browser. */
export const EMOJI_RECENT_LIMIT = 16;
