// An emoji for a word, chosen by meaning.
//
// Somebody asked for "an icon presentation for each word". The tempting way to do
// that is a lookup table of word -> emoji, which works for the fifty words you
// thought of and produces nothing for the other 49,950. So instead the emoji are
// the table: each one carries a handful of anchor words, and a guess gets whichever
// anchor it is closest to in the same embedding space the game already ranks with.
// `fireplace` gets 🔥 without anybody having listed `fireplace`.
//
// Three properties make this worth doing rather than clever:
//
//   free       one dot product per anchor, against rows that are already
//              unit-normalised and already in memory. A word costs ~180 x 300
//              multiplies once, then it is memoised for the life of the process.
//   silent     below the threshold a word gets *no* icon. A wrong icon is worse
//              than a blank: it is a false hint about what the word means, in a
//              game about meaning. Most words come back empty and that is the
//              intended hit rate, not a shortfall.
//   offline    no dictionary, no network, no model. It works on a laptop with the
//              wifi off, which is where this game gets played.
//
// It is emphatically not a definition. It is "what neighbourhood is this in",
// drawn at 14 pixels — which is exactly what a player scanning forty guess rows
// can use, and why the word panel exists separately for when they want the real
// answer.
//
// ## Two things the calibration taught us, kept here so nobody repeats them
//
// **Antonyms are near-synonyms in this space.** `slow` and `quick` score high,
// because they appear in identical sentences. An anchor set built around one half
// of an opposition confidently mislabels the other half, so `slow`, `hot`, `cold`,
// `quiet`, `dark`, `up` and `down` were tried, produced 🐌 for "quick", and were
// removed. Everything left is a *thing* or a *place*, where there is no opposite
// to confuse it with.
//
// **Idioms poison anchors.** `boot` matched "camp"; `key` matched "critical";
// `saw` matched "took"; `rock` matched "roll"; `web` matched "content". Each was
// a single word doing double duty, and the fix each time was to pick the
// unambiguous cousin — `footwear`, `padlock`, `sawmill`, `boulder`, `arachnid`.

import type { Ranker } from "./ranker.ts";

/**
 * The anchor table.
 *
 * Anchors are ordinary mid-frequency words, because the pack knows those best.
 * Three each: one anchor makes the emoji a synonym of that single word, and a
 * dozen dilutes it until everything matches it weakly. Each is chosen to be
 * unambiguous on its own — see the note above about idioms.
 *
 * Ties go to whichever comes first, so the more specific groups sit higher.
 */
const ICONS: { glyph: string; words: string[] }[] = [
  // --- people and body ---
  { glyph: "👤", words: ["human", "humans", "person"] },
  { glyph: "👨‍👩‍👧", words: ["family", "parents", "household"] },
  { glyph: "👶", words: ["baby", "infant", "newborn"] },
  { glyph: "🧒", words: ["child", "toddler", "youngster"] },
  { glyph: "👴", words: ["pensioner", "grandparent", "elderly"] },
  { glyph: "👫", words: ["friendship", "companion", "comrade"] },
  { glyph: "🫀", words: ["heart", "lung", "kidney"] },
  { glyph: "🧠", words: ["brain", "cognitive", "neural"] },
  { glyph: "🦴", words: ["bone", "skeleton", "spine"] },
  { glyph: "👁️", words: ["eyesight", "eyeball", "retina"] },
  { glyph: "🖐️", words: ["fingers", "thumb", "palm"] },
  { glyph: "🦵", words: ["knee", "ankle", "thigh"] },
  { glyph: "💪", words: ["muscle", "biceps", "muscular"] },
  { glyph: "🩺", words: ["clinic", "physician", "medical"] },
  { glyph: "💊", words: ["medicine", "tablet", "pill"] },
  { glyph: "🤒", words: ["illness", "disease", "ailment"] },
  { glyph: "🩹", words: ["wound", "injury", "bandage"] },

  // --- feeling ---
  { glyph: "😀", words: ["happiness", "joyful", "cheerful"] },
  { glyph: "😢", words: ["sorrow", "grief", "weeping"] },
  { glyph: "😡", words: ["anger", "rage", "fury"] },
  { glyph: "😨", words: ["fear", "afraid", "terror"] },
  { glyph: "😮", words: ["surprise", "astonished", "amazement"] },
  { glyph: "❤️", words: ["love", "affection", "romance"] },
  { glyph: "😴", words: ["sleep", "drowsy", "slumber"] },
  { glyph: "🤔", words: ["ponder", "contemplate", "wonder"] },
  { glyph: "😳", words: ["embarrassed", "blushing", "humiliated"] },

  // --- animals ---
  { glyph: "🐕", words: ["dog", "puppy", "hound"] },
  { glyph: "🐈", words: ["cat", "kitten", "feline"] },
  { glyph: "🐴", words: ["horse", "pony", "stallion"] },
  { glyph: "🐄", words: ["cow", "cattle", "livestock"] },
  { glyph: "🐖", words: ["pig", "swine", "pork"] },
  { glyph: "🐑", words: ["sheep", "lamb", "goat"] },
  { glyph: "🐦", words: ["bird", "sparrow", "pigeon"] },
  { glyph: "🐟", words: ["fish", "salmon", "trout"] },
  { glyph: "🐋", words: ["whale", "dolphin", "shark"] },
  { glyph: "🦋", words: ["butterfly", "moth", "insect"] },
  { glyph: "🐝", words: ["bee", "wasp", "hornet"] },
  { glyph: "🕷️", words: ["spider", "spiders", "tarantula"] },
  { glyph: "🐍", words: ["snake", "serpent", "reptile"] },
  { glyph: "🦁", words: ["lion", "tiger", "leopard"] },
  { glyph: "🐘", words: ["elephant", "rhino", "giraffe"] },
  { glyph: "🐻", words: ["bear", "wolf", "fox"] },
  { glyph: "🐭", words: ["rat", "rodent", "hamster"] },

  // --- plants and land ---
  { glyph: "🌳", words: ["tree", "oak", "forest"] },
  { glyph: "🌸", words: ["flower", "blossom", "petal"] },
  { glyph: "🌿", words: ["leaf", "herb", "foliage"] },
  { glyph: "🌱", words: ["seedling", "sprout", "germinate"] },
  { glyph: "🌾", words: ["wheat", "grain", "harvest"] },
  { glyph: "🍄", words: ["mushroom", "fungus", "mould"] },
  { glyph: "🏔️", words: ["mountain", "summit", "peaks"] },
  { glyph: "🏝️", words: ["island", "beach", "shore"] },
  { glyph: "🏜️", words: ["desert", "sand", "dune"] },
  { glyph: "🌊", words: ["ocean", "tide", "surf"] },
  { glyph: "🏞️", words: ["meadow", "countryside", "pasture"] },
  { glyph: "🪨", words: ["boulder", "pebble", "stone"] },
  { glyph: "🌍", words: ["earth", "planet", "globe"] },

  // --- weather and sky ---
  { glyph: "☀️", words: ["sunshine", "sunny", "sunlight"] },
  { glyph: "🌧️", words: ["rain", "rainfall", "drizzle"] },
  { glyph: "❄️", words: ["snow", "frost", "snowfall"] },
  { glyph: "⛈️", words: ["storm", "thunder", "lightning"] },
  { glyph: "🌫️", words: ["fog", "mist", "haze"] },
  { glyph: "💨", words: ["wind", "breeze", "gust"] },
  { glyph: "🌙", words: ["moon", "lunar", "moonlight"] },
  { glyph: "⭐", words: ["starlight", "constellation", "stellar"] },
  { glyph: "🌡️", words: ["temperature", "thermometer", "degrees"] },

  // --- elements ---
  { glyph: "🔥", words: ["fire", "flame", "burning"] },
  { glyph: "💧", words: ["water", "liquid", "moisture"] },
  { glyph: "⚡", words: ["electricity", "voltage", "electrical"] },
  { glyph: "💡", words: ["lamp", "brightness", "illumination"] },
  { glyph: "💥", words: ["explosion", "blast", "detonation"] },
  { glyph: "🧪", words: ["chemical", "chemistry", "reagent"] },
  { glyph: "⚛️", words: ["atom", "nuclear", "particle"] },
  { glyph: "🧲", words: ["magnet", "magnetic", "magnetism"] },

  // --- food and drink ---
  { glyph: "🍞", words: ["bread", "loaf", "baking"] },
  { glyph: "🍎", words: ["apple", "pear", "fruit"] },
  { glyph: "🥕", words: ["vegetable", "carrot", "potato"] },
  { glyph: "🍖", words: ["meat", "beef", "steak"] },
  { glyph: "🧀", words: ["cheese", "butter", "dairy"] },
  { glyph: "🍚", words: ["rice", "noodle", "pasta"] },
  { glyph: "🍰", words: ["cake", "dessert", "pastry"] },
  { glyph: "🍬", words: ["sugar", "candy", "confectionery"] },
  { glyph: "🧂", words: ["salt", "pepper", "spice"] },
  { glyph: "☕", words: ["coffee", "tea", "brewed"] },
  { glyph: "🍺", words: ["beer", "wine", "alcohol"] },
  { glyph: "🍽️", words: ["meal", "dinner", "restaurant"] },
  { glyph: "🍳", words: ["cooking", "recipe", "kitchen"] },

  // --- home and objects ---
  { glyph: "🏠", words: ["house", "cottage", "bungalow"] },
  { glyph: "🚪", words: ["door", "doorway", "entrance"] },
  { glyph: "🪟", words: ["window", "pane", "windowsill"] },
  { glyph: "🛏️", words: ["bed", "mattress", "bedroom"] },
  { glyph: "🪑", words: ["armchair", "sofa", "furniture"] },
  { glyph: "🚿", words: ["bathroom", "shower", "washing"] },
  { glyph: "🧹", words: ["sweeping", "tidying", "broom"] },
  { glyph: "🔑", words: ["padlock", "keyhole", "unlock"] },
  { glyph: "🪞", words: ["mirror", "reflection", "mirrors"] },
  { glyph: "🕯️", words: ["candle", "wax", "lantern"] },
  { glyph: "🧺", words: ["basket", "laundry", "hamper"] },

  // --- tools and making ---
  { glyph: "🔨", words: ["hammer", "nails", "chisel"] },
  { glyph: "🔧", words: ["wrench", "spanner", "mechanic"] },
  { glyph: "🪚", words: ["carpentry", "woodwork", "sawmill"] },
  { glyph: "✂️", words: ["scissors", "snip", "trimming"] },
  { glyph: "🧵", words: ["thread", "sewing", "stitch"] },
  { glyph: "🏗️", words: ["construction", "scaffolding", "crane"] },
  { glyph: "🏭", words: ["factory", "manufacturing", "industrial"] },
  { glyph: "⚙️", words: ["machinery", "mechanical", "engine"] },
  { glyph: "🧱", words: ["brick", "masonry", "bricks"] },

  // --- clothing ---
  { glyph: "👕", words: ["shirt", "garment", "blouse"] },
  { glyph: "👖", words: ["trousers", "jeans", "shorts"] },
  { glyph: "👗", words: ["dress", "skirt", "gown"] },
  { glyph: "🧥", words: ["coat", "jacket", "sweater"] },
  { glyph: "👟", words: ["footwear", "sneakers", "sandals"] },
  { glyph: "🎩", words: ["hat", "cap", "helmet"] },
  { glyph: "💎", words: ["jewel", "diamond", "gemstone"] },

  // --- travel ---
  { glyph: "🚗", words: ["car", "vehicle", "automobile"] },
  { glyph: "🚌", words: ["bus", "coach", "tram"] },
  { glyph: "🚆", words: ["train", "railway", "locomotive"] },
  { glyph: "✈️", words: ["aircraft", "aeroplane", "airline"] },
  { glyph: "🚢", words: ["ship", "vessel", "boat"] },
  { glyph: "🚲", words: ["bicycle", "cycling", "cyclist"] },
  { glyph: "🛣️", words: ["road", "highway", "motorway"] },
  { glyph: "🌉", words: ["bridge", "viaduct", "aqueduct"] },
  { glyph: "🧭", words: ["compass", "northward", "southward"] },
  { glyph: "🗺️", words: ["map", "atlas", "cartography"] },
  { glyph: "🧳", words: ["luggage", "suitcase", "baggage"] },
  { glyph: "🚀", words: ["rocket", "spacecraft", "spaceflight"] },

  // --- city and institutions ---
  { glyph: "🏙️", words: ["city", "urban", "metropolis"] },
  { glyph: "🏛️", words: ["government", "parliament", "ministry"] },
  { glyph: "⚖️", words: ["law", "legal", "justice"] },
  { glyph: "👮", words: ["police", "constable", "policeman"] },
  { glyph: "🚒", words: ["firefighter", "brigade", "rescue"] },
  { glyph: "🏥", words: ["hospital", "ward", "surgery"] },
  { glyph: "🏫", words: ["classroom", "schoolteacher", "pupils"] },
  { glyph: "🎓", words: ["university", "graduate", "degree"] },
  { glyph: "🏦", words: ["bank", "banking", "deposit"] },
  { glyph: "🏪", words: ["shop", "store", "retail"] },
  { glyph: "⛪", words: ["church", "temple", "worship"] },
  { glyph: "🏰", words: ["castle", "fortress", "palace"] },
  { glyph: "🪖", words: ["army", "soldier", "military"] },
  { glyph: "🗳️", words: ["election", "ballot", "referendum"] },

  // --- money and work ---
  { glyph: "💰", words: ["cash", "money", "currency"] },
  { glyph: "💳", words: ["payment", "invoice", "billing"] },
  { glyph: "📈", words: ["growth", "increase", "profit"] },
  { glyph: "📉", words: ["decline", "recession", "downturn"] },
  { glyph: "🤝", words: ["agreement", "deal", "partnership"] },
  { glyph: "💼", words: ["corporate", "commercial", "enterprise"] },
  { glyph: "🏢", words: ["headquarters", "premises", "offices"] },
  { glyph: "📊", words: ["statistics", "dataset", "spreadsheet"] },
  { glyph: "🧾", words: ["receipt", "expense", "expenditure"] },
  { glyph: "⏰", words: ["clock", "hour", "minutes"] },
  { glyph: "📅", words: ["calendar", "schedule", "timetable"] },

  // --- language and thought ---
  { glyph: "📖", words: ["book", "novel", "reading"] },
  { glyph: "✏️", words: ["pencil", "handwriting", "scribble"] },
  { glyph: "📰", words: ["newspaper", "journalism", "tabloid"] },
  { glyph: "💬", words: ["conversation", "talking", "chatting"] },
  { glyph: "📝", words: ["memo", "notebook", "notepad"] },
  { glyph: "🔤", words: ["alphabet", "spelling", "syllable"] },
  { glyph: "🌐", words: ["multilingual", "translation", "linguistic"] },
  { glyph: "🎯", words: ["target", "objective", "bullseye"] },
  { glyph: "🧩", words: ["puzzle", "riddle", "jigsaw"] },
  { glyph: "🔍", words: ["search", "investigation", "inquiry"] },
  { glyph: "📚", words: ["knowledge", "learning", "scholarship"] },
  { glyph: "🔬", words: ["laboratory", "microscope", "experiment"] },
  { glyph: "🧮", words: ["arithmetic", "calculation", "numeral"] },

  // --- computing ---
  { glyph: "💻", words: ["computer", "laptop", "software"] },
  { glyph: "📱", words: ["phone", "smartphone", "handset"] },
  { glyph: "🖥️", words: ["server", "hardware", "workstation"] },
  { glyph: "🔌", words: ["connector", "socket", "plug"] },
  { glyph: "📡", words: ["antenna", "transmission", "broadcast"] },
  { glyph: "🔐", words: ["encryption", "password", "credentials"] },
  { glyph: "🐛", words: ["bug", "defect", "glitch"] },
  { glyph: "🗄️", words: ["database", "archive", "repository"] },
  { glyph: "🤖", words: ["robot", "automation", "robotic"] },
  { glyph: "🦠", words: ["malware", "virus", "trojan"] },
  { glyph: "🕵️", words: ["surveillance", "espionage", "eavesdropping"] },

  // --- art and play ---
  { glyph: "🎵", words: ["music", "song", "melody"] },
  { glyph: "🎸", words: ["guitar", "violin", "instrument"] },
  { glyph: "🎨", words: ["painting", "sculpture", "canvas"] },
  { glyph: "🎬", words: ["film", "cinema", "movie"] },
  { glyph: "🎭", words: ["theatre", "drama", "playwright"] },
  { glyph: "📷", words: ["photograph", "camera", "photography"] },
  { glyph: "🎮", words: ["gaming", "console", "videogame"] },
  { glyph: "⚽", words: ["football", "soccer", "goalkeeper"] },
  { glyph: "🏀", words: ["basketball", "baseball", "tennis"] },
  { glyph: "🏃", words: ["sprinting", "jogging", "athlete"] },
  { glyph: "🏆", words: ["trophy", "champion", "winner"] },
  { glyph: "🎉", words: ["celebration", "festivity", "carnival"] },
  { glyph: "🎁", words: ["gift", "present", "souvenir"] },
  { glyph: "🃏", words: ["gambling", "poker", "casino"] },

  // --- states of affairs ---
  //
  // No ✅/❌ pair here, and not for want of trying: "confirmed" and "rejected"
  // are so close to every reporting verb in a news corpus that they claimed
  // "announced", "designated", "proven" and "reviewed" as well. Approval is a
  // relationship between people, not a thing a single word can be.
  { glyph: "⚠️", words: ["hazard", "hazardous", "peril"] },
  { glyph: "🛡️", words: ["protection", "defence", "shield"] },
  { glyph: "⚔️", words: ["war", "battle", "combat"] },
  { glyph: "🕊️", words: ["peace", "harmony", "truce"] },
  { glyph: "🤫", words: ["secret", "confidential", "clandestine"] },
  { glyph: "📏", words: ["measurement", "length", "centimetre"] },
  { glyph: "🔗", words: ["connection", "linkage", "attached"] },
  { glyph: "🗑️", words: ["rubbish", "garbage", "landfill"] },
  { glyph: "♻️", words: ["recycling", "renewable", "sustainable"] },
  { glyph: "🌈", words: ["colour", "hue", "rainbow"] },
  { glyph: "🔊", words: ["loudness", "audible", "acoustic"] },
  { glyph: "👑", words: ["king", "queen", "royal"] },
  { glyph: "🪦", words: ["funeral", "grave", "burial"] },
  { glyph: "🎂", words: ["birthday", "anniversary", "jubilee"] },
  { glyph: "💍", words: ["wedding", "betrothal", "marriage"] },
  { glyph: "🙏", words: ["prayer", "faith", "religion"] },
  { glyph: "🧘", words: ["meditation", "relaxation", "mindfulness"] },
  { glyph: "▶️", words: ["begin", "commence", "commencing"] },
  { glyph: "🏁", words: ["finish", "finale", "completion"] },
  { glyph: "⏸️", words: ["halt", "pause", "suspend"] },
  { glyph: "🔁", words: ["repeat", "recurring", "repetition"] },
];

/**
 * How close a word must be to an anchor before it earns that anchor's emoji.
 *
 * Calibrated against the real pack rather than guessed, because cosine numbers
 * here are nothing like the [0, 1] intuition suggests. In this space two entirely
 * unrelated words — `dog` and `invoice` — score 0.26, and *everything* scores at
 * least that, so a threshold of 0.3 gives every word an icon and most of them are
 * nonsense. Real synonyms sit at 0.64 to 0.78 (`dog`/`puppy` 0.78, `fire`/`flame`
 * 0.64); loose associations sit in between (`page`/`link` 0.48, `content`/`web`
 * 0.52) and are exactly what has to be excluded.
 *
 * 0.62 sits at the bottom of the synonym band. It labels roughly a quarter of
 * words, which reads as "some words have one" rather than as a broken column.
 * Lowering it does not add information, it adds confident mistakes.
 */
export const ICON_THRESHOLD = 0.62;

export interface IconPicker {
  /** The emoji for `word`, or null when nothing is close enough to be honest. */
  (word: string): string | null;
}

/**
 * Bind the anchor table to a ranker.
 *
 * Anchors absent from the pack are dropped at construction, so a sample pack
 * simply yields fewer icons rather than throwing. The memo is unbounded on
 * purpose and bounded in practice: it can only ever hold one entry per word in
 * the vocabulary, and a real session touches a few hundred.
 */
export function createIconPicker(ranker: Ranker, threshold = ICON_THRESHOLD): IconPicker {
  const anchors: { glyph: string; word: string }[] = [];
  for (const icon of ICONS) {
    for (const word of icon.words) {
      if (ranker.knows(word)) anchors.push({ glyph: icon.glyph, word });
    }
  }

  const memo = new Map<string, string | null>();
  return (word: string): string | null => {
    const hit = memo.get(word);
    if (hit !== undefined) return hit;

    let best: string | null = null;
    let bestSim = threshold;
    for (const anchor of anchors) {
      // An anchor scoring 1.0 against itself is the identity case, and it is the
      // right answer: `fire` should get 🔥.
      const sim = ranker.similarity(word, anchor.word);
      if (sim !== null && sim > bestSim) {
        bestSim = sim;
        best = anchor.glyph;
      }
    }
    memo.set(word, best);
    return best;
  };
}

/** Every anchor word the table declares, so a test can check the pack has them. */
export function iconAnchors(): string[] {
  return ICONS.flatMap((icon) => icon.words);
}
