// Word list for the synthetic sample pack (`deno task ingest --sample`).
//
// Words are grouped domain -> cluster. The generator gives every domain a random
// base vector, every cluster a second one, and every word its own jitter, so
// same-cluster words rank very close, same-domain words rank moderately close,
// and unrelated words rank far apart. That is enough structure for the game to
// feel real while testing, without a 700 MB download.

export interface SampleDomain {
  name: string;
  clusters: string[][];
}

export const SAMPLE_DOMAINS: SampleDomain[] = [
  {
    name: "animals",
    clusters: [
      ["cat", "kitten", "feline", "tabby", "purr", "whiskers", "paw", "meow"],
      ["dog", "puppy", "canine", "hound", "beagle", "terrier", "bark", "leash"],
      ["horse", "pony", "stallion", "mare", "foal", "saddle", "gallop", "hoof"],
      ["bird", "sparrow", "eagle", "owl", "raven", "feather", "beak", "nest", "wing"],
      ["fish", "salmon", "trout", "shark", "whale", "dolphin", "gill", "fin", "coral"],
      ["insect", "bee", "wasp", "ant", "beetle", "moth", "butterfly", "spider", "hive"],
      ["bear", "wolf", "fox", "deer", "rabbit", "squirrel", "moose", "badger"],
      ["lion", "tiger", "leopard", "elephant", "giraffe", "zebra", "rhino", "safari"],
    ],
  },
  {
    name: "food",
    clusters: [
      ["bread", "loaf", "toast", "bagel", "dough", "yeast", "bakery", "crust"],
      ["cheese", "cheddar", "butter", "cream", "yogurt", "milk", "dairy"],
      ["apple", "pear", "peach", "cherry", "berry", "grape", "orange", "lemon", "mango"],
      ["potato", "carrot", "onion", "tomato", "cabbage", "pepper", "spinach", "celery"],
      ["coffee", "espresso", "latte", "tea", "brew", "mug", "caffeine", "kettle"],
      ["dinner", "lunch", "breakfast", "supper", "meal", "recipe", "kitchen", "chef"],
      ["sugar", "honey", "candy", "chocolate", "dessert", "cake", "cookie", "pastry"],
      ["salt", "spice", "garlic", "ginger", "cumin", "basil", "flavour", "savoury"],
    ],
  },
  {
    name: "weather",
    clusters: [
      ["rain", "drizzle", "shower", "downpour", "puddle", "umbrella", "damp"],
      ["snow", "blizzard", "frost", "ice", "sleet", "glacier", "icicle", "shovel"],
      ["storm", "thunder", "lightning", "hurricane", "tornado", "gale", "squall"],
      ["sun", "sunshine", "heat", "warmth", "drought", "sunburn", "scorching"],
      ["cloud", "fog", "mist", "haze", "overcast", "humid", "breeze", "wind"],
    ],
  },
  {
    name: "buildings",
    clusters: [
      ["house", "home", "cottage", "cabin", "bungalow", "mansion", "villa"],
      ["room", "kitchen", "bedroom", "hallway", "attic", "basement", "closet"],
      ["door", "window", "roof", "wall", "floor", "ceiling", "staircase", "porch"],
      ["city", "town", "village", "suburb", "district", "neighbourhood", "street"],
      ["bridge", "tunnel", "tower", "castle", "fortress", "cathedral", "temple"],
      ["office", "factory", "warehouse", "workshop", "garage", "studio", "lobby"],
    ],
  },
  {
    name: "transport",
    clusters: [
      ["car", "truck", "van", "bus", "taxi", "engine", "wheel", "brake", "driver"],
      ["train", "railway", "station", "platform", "carriage", "locomotive", "track"],
      ["plane", "aircraft", "airport", "runway", "pilot", "cockpit", "flight"],
      ["boat", "ship", "ferry", "sail", "harbour", "anchor", "voyage", "deck"],
      ["bicycle", "bike", "pedal", "helmet", "saddle", "cyclist", "handlebar"],
      ["road", "highway", "junction", "roundabout", "traffic", "detour", "lane"],
    ],
  },
  {
    name: "work",
    clusters: [
      ["meeting", "agenda", "minutes", "briefing", "presentation", "slides"],
      ["manager", "colleague", "employee", "intern", "staff", "supervisor", "team"],
      ["salary", "wage", "bonus", "invoice", "budget", "expense", "payroll"],
      ["contract", "clause", "policy", "compliance", "audit", "regulation"],
      ["deadline", "schedule", "backlog", "milestone", "priority", "sprint"],
      ["email", "inbox", "message", "reply", "forward", "attachment", "draft"],
    ],
  },
  {
    name: "computing",
    clusters: [
      ["computer", "laptop", "desktop", "keyboard", "monitor", "mouse", "screen"],
      ["software", "program", "code", "compiler", "function", "variable", "syntax"],
      ["server", "network", "router", "protocol", "packet", "bandwidth", "latency"],
      ["database", "query", "table", "record", "schema", "backup", "storage"],
      ["password", "encryption", "firewall", "malware", "phishing", "breach", "patch"],
      ["internet", "browser", "website", "download", "upload", "streaming", "cache"],
    ],
  },
  {
    name: "nature",
    clusters: [
      ["tree", "oak", "pine", "birch", "willow", "branch", "trunk", "leaf", "bark"],
      ["flower", "rose", "tulip", "daisy", "orchid", "petal", "blossom", "bloom"],
      ["mountain", "hill", "cliff", "valley", "ridge", "summit", "canyon", "slope"],
      ["river", "stream", "lake", "pond", "waterfall", "estuary", "current"],
      ["forest", "woodland", "jungle", "grove", "thicket", "meadow", "prairie"],
      ["ocean", "sea", "beach", "shore", "tide", "wave", "sand", "dune", "reef"],
      ["desert", "dune", "oasis", "cactus", "arid", "barren", "wasteland"],
    ],
  },
  {
    name: "body",
    clusters: [
      ["hand", "finger", "thumb", "wrist", "palm", "knuckle", "elbow", "arm"],
      ["head", "face", "eye", "nose", "mouth", "ear", "cheek", "chin", "forehead"],
      ["leg", "knee", "ankle", "foot", "heel", "toe", "shin", "thigh"],
      ["heart", "lung", "liver", "kidney", "stomach", "brain", "nerve", "artery"],
      ["bone", "muscle", "tendon", "spine", "skull", "joint", "cartilage"],
      ["doctor", "nurse", "hospital", "clinic", "patient", "surgery", "diagnosis"],
    ],
  },
  {
    name: "emotion",
    clusters: [
      ["happy", "joy", "delight", "cheerful", "glad", "elated", "content"],
      ["sad", "sorrow", "grief", "misery", "gloom", "melancholy", "despair"],
      ["anger", "rage", "fury", "irritation", "resentment", "outrage", "temper"],
      ["fear", "terror", "dread", "anxiety", "panic", "worry", "phobia"],
      ["love", "affection", "romance", "passion", "tenderness", "devotion"],
      ["surprise", "shock", "astonishment", "wonder", "amazement", "disbelief"],
    ],
  },
  {
    name: "sport",
    clusters: [
      ["football", "soccer", "goal", "striker", "penalty", "offside", "pitch"],
      ["tennis", "racket", "serve", "volley", "baseline", "court", "deuce"],
      ["swimming", "pool", "freestyle", "backstroke", "lap", "goggles", "dive"],
      ["running", "marathon", "sprint", "jogging", "stamina", "finish", "pace"],
      ["chess", "pawn", "rook", "bishop", "checkmate", "gambit", "endgame"],
      ["team", "coach", "referee", "tournament", "champion", "trophy", "medal"],
    ],
  },
  {
    name: "language",
    clusters: [
      ["word", "sentence", "phrase", "clause", "paragraph", "grammar", "verb", "noun"],
      ["book", "novel", "chapter", "author", "library", "paperback", "manuscript"],
      ["speech", "conversation", "dialogue", "debate", "argument", "discussion"],
      ["letter", "alphabet", "vowel", "consonant", "syllable", "spelling"],
      ["puzzle", "riddle", "crossword", "anagram", "clue", "guess", "solution"],
      ["story", "legend", "myth", "fable", "narrative", "plot", "character"],
    ],
  },
  {
    name: "time",
    clusters: [
      ["morning", "dawn", "sunrise", "noon", "afternoon", "evening", "dusk", "night"],
      ["monday", "tuesday", "wednesday", "thursday", "friday", "weekend", "week"],
      ["january", "february", "spring", "summer", "autumn", "winter", "season"],
      ["hour", "minute", "second", "clock", "calendar", "schedule", "duration"],
      ["past", "present", "future", "history", "ancient", "modern", "century"],
    ],
  },
  {
    name: "money",
    clusters: [
      ["money", "cash", "coin", "banknote", "currency", "wallet", "change"],
      ["bank", "account", "deposit", "withdrawal", "interest", "mortgage", "loan"],
      ["market", "trade", "stock", "share", "dividend", "investor", "portfolio"],
      ["price", "cost", "discount", "bargain", "receipt", "purchase", "refund"],
      ["shop", "store", "supermarket", "cashier", "checkout", "trolley", "aisle"],
    ],
  },
  {
    name: "music",
    clusters: [
      ["music", "melody", "harmony", "rhythm", "tempo", "chord", "note", "scale"],
      ["guitar", "piano", "violin", "drum", "trumpet", "flute", "cello", "banjo"],
      ["song", "singer", "chorus", "verse", "lyrics", "album", "single"],
      ["concert", "stage", "audience", "encore", "festival", "venue", "ticket"],
      ["orchestra", "conductor", "symphony", "sonata", "opera", "quartet"],
    ],
  },
  {
    name: "clothing",
    clusters: [
      ["shirt", "blouse", "sweater", "jacket", "coat", "hoodie", "cardigan"],
      ["trousers", "jeans", "shorts", "skirt", "dress", "uniform", "overall"],
      ["shoe", "boot", "sandal", "sneaker", "sock", "lace", "heel"],
      ["hat", "cap", "scarf", "glove", "belt", "tie", "button", "zipper"],
      ["fabric", "cotton", "wool", "silk", "linen", "leather", "denim", "stitch"],
    ],
  },
];
