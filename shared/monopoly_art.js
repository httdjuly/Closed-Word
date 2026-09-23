// Pictures for the board, drawn rather than fetched.
//
// Every square carries a small illustration: behind the name on the board, and
// full size on the deed card you get by tapping it. They are hand-written SVG in
// this file for one reason — a strict rule of this app is that nothing on a page
// may come from off the machine. There is no CDN, no build step and no network
// beyond the LAN, and a board game that showed broken image icons on a laptop
// with no internet would be worse than one with no pictures at all.
//
// So these are flat vector scenes: a handful of shapes each, no gradients, no
// filters, no text. They are motifs rather than portraits — "karst peaks over
// water", "container port", "terraced fields" — because twenty-two recognisable
// drawings of specific places is not a thing anybody can hand-draw in SVG, while
// twenty-two motifs that say *what kind of place this is* very much is, and that
// is what a player reads off a board square anyway.
//
// A scene is 100×60 (a postcard) and is always emitted with `slice`, so the same
// markup crops sensibly into a square board cell and fills a wide deed card.

/** Shared palette. Named for what the shape is, not for the colour. */
const C = {
  sky: "#d7eaf6",
  skyWarm: "#fce7cb",
  skyDusk: "#f6cfb8",
  skyNight: "#33436180",
  sun: "#f0b249",
  water: "#a4d0e4",
  waterDeep: "#63a6c6",
  sand: "#efdfbd",
  land: "#cfe0bb",
  hill: "#82ac79",
  hillDark: "#5f8a62",
  rock: "#9ba4ae",
  rockDark: "#78818c",
  city: "#8e96a8",
  cityDark: "#697386",
  leaf: "#4f8f57",
  leafDark: "#3b7145",
  roof: "#c05a45",
  roofAlt: "#d98f3f",
  wall: "#f5efe4",
  wood: "#a97448",
  gold: "#dfa63c",
  red: "#c8412f",
  white: "#ffffff",
  ink: "#5a6472",
};

const rect = (x, y, w, h, fill, extra = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra ? " " + extra : ""}/>`;
const sky = (fill) => rect(0, 0, 100, 60, fill);
const path = (d, fill) => `<path d="${d}" fill="${fill}"/>`;
const line = (x1, y1, x2, y2, stroke, w = 1.4) =>
  `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${stroke}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
const circle = (cx, cy, r, fill) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
/** An open curve, stroked. A curve with a `fill` draws a sliver, not a line. */
const curve = (d, stroke, w = 1.4) =>
  `<path d="${d}" stroke="${stroke}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
const box = (x, y, w, h, r, fill, stroke = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${
    stroke ? ` stroke="${stroke}" stroke-width="1.4"` : ""
  }/>`;

/** A hanging lantern: body, caps and tassel. */
const lantern = (x, y, r, fill) =>
  line(x, y - r * 2.4, x, y - r, "#8a5f3c", 0.8) +
  `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.82}" fill="${fill}"/>` +
  rect(x - r * 0.4, y - r * 0.95, r * 0.8, r * 0.3, "#8a5f3c") +
  rect(x - r * 0.4, y + r * 0.65, r * 0.8, r * 0.3, "#8a5f3c") +
  line(x, y + r * 0.95, x, y + r * 1.7, "#c8412f", 0.8);

/** A conifer, the one shape half these scenes need. */
const pine = (x, y, h, fill = C.leafDark) =>
  path(`M${x} ${y}L${x - h * 0.32} ${y + h}H${x + h * 0.32}Z`, fill) +
  rect(x - h * 0.05, y + h, h * 0.1, h * 0.12, C.wood);

/** A tiered roof, for pagodas, citadels and shophouses. */
const tier = (cx, y, w, fill = C.roof) =>
  path(
    `M${cx - w} ${y}Q${cx} ${y - w * 0.42} ${cx + w} ${y}L${cx + w * 0.72} ${y + w * 0.2}H${
      cx - w * 0.72
    }Z`,
    fill,
  );

/** A sampan under a conical sail, seen from the side. */
const boat = (x, y, s, hull = C.wood, sail = C.wall) =>
  path(`M${x - 6 * s} ${y}Q${x} ${y + 3.2 * s} ${x + 6 * s} ${y}Z`, hull) +
  path(`M${x} ${y - 8 * s}L${x + 4.4 * s} ${y}H${x - 0.6 * s}Z`, sail);

/** A five-pointed star, upright. The flag needs one; nothing else does. */
const star = (cx, cy, r, fill) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.382;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return `<path d="M${pts.join("L")}Z" fill="${fill}"/>`;
};

/**
 * Every scene, keyed by a Vietnamese motif name.
 *
 * Keys are Vietnamese because the motifs are, and because the person writing a
 * board file is writing Vietnamese place names next to them. A map file may name
 * any key here; anything else is reported and replaced rather than drawn blank.
 */
export const SCENES = {
  // --- highland and forest -------------------------------------------------
  nui: sky(C.sky) +
    path("M0 60L26 20L46 60Z", C.rockDark) +
    path("M20 60L52 10L84 60Z", C.rock) +
    path("M44 21L52 10L60 21L52 25Z", C.white) +
    path("M60 60L86 28L100 60Z", C.hillDark),

  // Terraces read as terraces only if the steps are visible, so each band is a
  // flat colour and the lip between them is a pale stroke — the standing water
  // catching the light, which is what you actually see on a hillside.
  ruong: sky(C.sky) +
    path("M0 60V26Q50 12 100 26V60Z", "#6b955c") +
    path("M0 30Q50 16 100 30V39Q50 25 0 39Z", "#a3cd8a") +
    path("M0 41Q50 27 100 41V50Q50 36 0 50Z", "#8cbb75") +
    path("M0 52Q50 38 100 52V60H0Z", "#77a463") +
    curve("M0 30Q50 16 100 30", "#f2fbe9", 0.9) +
    curve("M0 41Q50 27 100 41", "#f2fbe9", 0.9) +
    curve("M0 52Q50 38 100 52", "#f2fbe9", 0.9),

  thacnuoc: sky(C.sky) +
    path("M0 60V20Q50 10 100 20V60Z", C.hillDark) +
    rect(16, 22, 68, 24, "#e6f5fb") +
    curve("M28 24V44", C.white, 2) + curve("M44 23V45", C.white, 2.4) +
    curve("M58 23V45", C.white, 2) + curve("M72 25V44", C.white, 1.6) +
    rect(0, 44, 100, 16, C.water) +
    circle(30, 46, 4, C.white) + circle(50, 47, 5, C.white) + circle(70, 46, 4, C.white) +
    pine(12, 8, 14, C.leafDark) + pine(88, 10, 12, C.leafDark),

  deo: sky(C.sky) +
    path("M0 60L32 14L58 60Z", C.hill) +
    path("M42 60L76 18L100 60Z", C.hillDark) +
    curve("M16 60Q44 50 30 40Q18 32 44 26", "#9aa3ad", 5) +
    curve("M16 60Q44 50 30 40Q18 32 44 26", "#e4dccb", 1) +
    pine(66, 26, 14, C.leafDark) + pine(86, 34, 12, C.leafDark),

  karst: sky(C.sky) +
    path("M6 46L17 14L28 46Z", C.rock) +
    path("M32 46L46 6L60 46Z", C.rockDark) +
    path("M62 46L73 18L85 46Z", C.rock) +
    rect(0, 44, 100, 16, C.water) +
    boat(70, 51, 0.7),

  rung: sky("#e2f0e2") +
    rect(0, 44, 100, 16, C.land) +
    pine(20, 12, 32) + pine(48, 6, 38) + pine(76, 16, 28) +
    path("M0 60Q50 48 100 60Z", C.hillDark),

  che: sky(C.sky) +
    path("M0 60V32Q50 20 100 32V60Z", C.hill) +
    curve("M0 40Q25 33 50 40T100 40", C.leafDark, 5) +
    curve("M0 50Q25 43 50 50T100 50", C.leaf, 5) +
    curve("M0 59Q25 52 50 59T100 59", C.leafDark, 5),

  hoa: sky(C.skyWarm) +
    path("M0 60V32Q50 22 100 32V60Z", "#d3e4bd") +
    pine(18, 6, 28) + pine(50, 14, 20) + pine(82, 10, 25) +
    circle(30, 50, 3.4, "#e77fa4") + circle(44, 54, 3, "#f0b249") +
    circle(58, 49, 3.4, "#e77fa4") + circle(72, 54, 3, "#ffffff") +
    circle(86, 50, 3, "#e77fa4"),

  caphe: sky(C.skyWarm) +
    path("M0 60V34Q50 24 100 34V60Z", C.hill) +
    curve("M0 42Q25 35 50 42T100 42", C.leafDark, 5) +
    curve("M0 54Q25 47 50 54T100 54", C.leaf, 5) +
    circle(18, 40, 2.4, C.red) + circle(42, 43, 2.4, C.red) + circle(66, 40, 2.4, C.red) +
    circle(88, 44, 2.4, C.red) + circle(30, 53, 2.4, "#a8352a") +
    circle(74, 53, 2.4, "#a8352a"),

  // A road running out to a gate with the barrier down. The barrier is the part
  // that says "border" rather than "arch", so it gets the stripes.
  cuakhau: sky(C.sky) +
    path("M0 60V40Q50 32 100 40V60Z", C.land) +
    path("M28 60L44 34H56L72 60Z", "#8e96a8") +
    rect(22, 22, 8, 26, "#e4dccb") + rect(70, 22, 8, 26, "#e4dccb") +
    rect(18, 15, 64, 8, C.roof) +
    rect(30, 33, 40, 3.4, C.red) + rect(30, 33, 10, 3.4, C.white) +
    rect(50, 33, 10, 3.4, C.white) +
    rect(49, 6, 2, 9, C.ink) + path("M51 6L63 9L51 12Z", C.red),

  // --- coast and water -----------------------------------------------------
  bien: sky(C.sky) +
    circle(78, 16, 8, C.sun) +
    rect(0, 30, 100, 16, C.water) +
    path("M0 46Q50 38 100 46V60H0Z", C.sand) +
    rect(21, 26, 2.4, 22, C.wood) +
    path("M22 26Q10 22 8 30Q18 28 22 32Q26 22 38 26Q30 20 22 26Z", C.leaf),

  dao: sky(C.sky) +
    rect(0, 34, 100, 26, C.water) +
    path("M52 34Q70 16 88 34Z", C.hill) +
    rect(65, 20, 2, 14, C.wood) +
    path("M66 20Q56 17 54 24Q62 22 66 26Q70 17 80 21Q72 15 66 20Z", C.leaf) +
    boat(24, 40, 0.9, C.wood, C.white),

  thuyen: sky(C.skyDusk) +
    circle(20, 20, 9, C.sun) +
    rect(0, 34, 100, 26, C.waterDeep) +
    boat(38, 42, 1.3) + boat(70, 47, 1) +
    path("M0 52Q50 46 100 52V60H0Z", "#4d93b3"),

  songnuoc: sky(C.sky) +
    path("M0 30Q50 22 100 30V60H0Z", C.water) +
    boat(28, 42, 1.1, "#8a5f3c", C.wall) + boat(66, 50, 1.3, "#8a5f3c", C.roofAlt) +
    path("M0 30Q30 26 46 30", C.leafDark) +
    pine(8, 14, 16, C.leafDark) + pine(92, 16, 14, C.leafDark),

  cang: sky(C.sky) +
    rect(0, 40, 100, 20, C.waterDeep) +
    rect(10, 16, 4, 26, C.ink) + rect(10, 16, 46, 3.4, C.ink) + rect(52, 16, 4, 12, C.ink) +
    rect(62, 30, 12, 6, C.red) + rect(62, 24, 12, 6, "#e0a63c") + rect(76, 30, 12, 6, "#3f7f8f") +
    path("M20 46H92L86 54H26Z", "#5a6472"),

  sen: sky(C.sky) +
    rect(0, 34, 100, 26, "#b9d9e4") +
    curve("M0 33Q28 27 54 33T100 31", C.leafDark, 3) +
    circle(24, 45, 6, C.leaf) + circle(58, 51, 7, C.leaf) + circle(82, 42, 5, C.leaf) +
    path("M42 44Q37 35 42 30Q47 35 50 29Q54 35 50 44Z", "#e88fae") +
    rect(45, 44, 2, 8, C.leafDark),

  // --- towns and cities ----------------------------------------------------
  hoangthanh: sky(C.skyWarm) +
    rect(0, 46, 100, 14, "#b9d9e4") +
    rect(18, 32, 64, 14, "#cbbfa6") +
    tier(50, 32, 22, C.roof) + tier(50, 20, 13, C.roof) +
    rect(49, 6, 2, 8, C.ink) + path("M51 6L64 9L51 12Z", C.red),

  // A pavilion out on the water. Wider body and visible stilts, because a narrow
  // body under a curved roof is a mushroom and nothing else.
  thudo: sky(C.sky) +
    rect(0, 36, 100, 24, "#a9cfe0") +
    rect(39, 36, 3, 11, C.wood) + rect(58, 36, 3, 11, C.wood) +
    rect(36, 22, 28, 14, "#e4d9c2") +
    rect(47, 26, 6, 10, C.roof) +
    tier(50, 22, 18, C.roof) + tier(50, 12, 11, C.roof) +
    rect(49, 6, 2, 6, C.gold) +
    pine(12, 18, 20, C.leafDark) + pine(88, 21, 17, C.leafDark) +
    curve("M0 50Q50 46 100 50", "#7fb6ce", 1.2),

  dothi: sky(C.skyDusk) +
    rect(14, 20, 14, 40, C.cityDark) + rect(32, 8, 12, 52, C.city) +
    rect(48, 26, 16, 34, C.cityDark) + rect(68, 16, 11, 44, C.city) +
    rect(82, 32, 12, 28, C.cityDark) +
    rect(35, 14, 3, 3, C.gold) + rect(35, 22, 3, 3, C.gold) + rect(71, 24, 3, 3, C.gold) +
    rect(52, 34, 3, 3, C.gold) + rect(18, 30, 3, 3, C.gold) +
    rect(0, 56, 100, 4, "#4c556b"),

  phoco: sky(C.skyWarm) +
    rect(8, 22, 20, 38, "#f0d9a8") + rect(30, 28, 18, 32, "#e6b6a0") +
    rect(50, 18, 20, 42, "#dfe6cf") + rect(72, 26, 20, 34, "#f0d9a8") +
    path("M6 22H30L28 16H8Z", C.roof) + path("M28 28H50L48 23H30Z", "#a8563f") +
    path("M48 18H72L70 12H50Z", C.roof) + path("M70 26H94L92 21H72Z", "#a8563f") +
    rect(0, 56, 100, 4, "#c9bda6"),

  denlong: sky("#f3cdb0") +
    rect(0, 44, 100, 16, "#b9805f") +
    curve("M0 10Q50 16 100 10", "#8a5f3c", 1) +
    lantern(18, 24, 6.5, C.red) + lantern(40, 28, 5.5, C.gold) +
    lantern(62, 24, 6.5, C.red) + lantern(84, 29, 5.5, C.gold) +
    circle(18, 52, 4, "#d86a55") + circle(62, 53, 4, "#d8a05a"),

  cho: sky(C.sky) +
    rect(0, 46, 100, 14, "#ddd2bb") +
    path("M6 26H40L46 34H12Z", C.red) + path("M52 22H88L94 30H58Z", "#3f7f8f") +
    rect(14, 34, 3, 12, C.wood) + rect(40, 34, 3, 12, C.wood) +
    rect(60, 30, 3, 16, C.wood) + rect(88, 30, 3, 16, C.wood) +
    circle(24, 43, 4, C.roofAlt) + circle(70, 41, 4, C.leaf),

  duongpho: sky(C.sky) +
    rect(0, 12, 24, 34, C.city) + rect(76, 16, 24, 30, C.cityDark) +
    path("M36 46L46 20H54L64 46Z", "#dfd6c2") +
    path("M0 60L38 30H62L100 60Z", "#7c8493") +
    rect(48, 34, 4, 5, C.white) + rect(46, 44, 8, 6, C.white) + rect(43, 54, 14, 6, C.white),

  hocuoc: sky(C.sky) +
    rect(0, 30, 100, 30, "#a9cfe0") +
    rect(20, 16, 8, 14, C.city) + rect(32, 10, 7, 20, C.cityDark) + rect(44, 18, 9, 12, C.city) +
    path("M0 44Q50 38 100 44", C.water) +
    boat(74, 44, 0.8, C.wood, C.white),

  chua: sky(C.skyWarm) +
    rect(0, 48, 100, 12, "#ddd2bb") +
    rect(42, 20, 16, 28, "#e4d9c2") +
    tier(50, 20, 16, C.roof) + tier(50, 12, 11, C.roof) + tier(50, 5, 7, C.roof) +
    rect(38, 48, 24, 3, "#c9bda6"),

  cauvong: sky(C.sky) +
    rect(0, 40, 100, 20, C.water) +
    path("M4 40Q50 8 96 40H88Q50 18 12 40Z", C.gold) +
    line(50, 14, 50, 40, C.ink, 1) + line(30, 22, 30, 40, C.ink, 1) +
    line(70, 22, 70, 40, C.ink, 1) +
    rect(0, 52, 100, 8, "#7fb6ce"),

  nhamay: sky("#dfe4e8") +
    rect(0, 44, 100, 16, "#c9c2b4") +
    rect(14, 26, 34, 18, C.cityDark) + rect(52, 32, 30, 12, C.city) +
    rect(20, 8, 6, 18, "#8b93a6") + rect(34, 14, 6, 12, "#8b93a6") +
    circle(24, 6, 4, "#e6e9ec") + circle(31, 3, 3, "#e6e9ec") + circle(38, 10, 3, "#e6e9ec"),

  // --- the four transport squares and the two utilities --------------------
  // Seen from above, which is the one view of an aircraft that is unmistakable at
  // twenty pixels across. Clouds rather than a runway: mixing a plan view of the
  // plane with an elevation of the ground was what made the first attempt read as
  // a paper dart.
  // A solid silhouette. Two goes at a pale, shaded aircraft both vanished into
  // the sky at square size — a plan-view plane only reads if it is dark on light.
  sanbay: sky("#e4f1f9") +
    circle(16, 13, 7, C.white) + circle(25, 15, 5, C.white) +
    circle(80, 45, 6, C.white) + circle(89, 47, 4.5, C.white) +
    path("M50 24L89 41V46L50 35L11 46V41Z", "#6d7f93") +
    path("M50 45L69 54V57L50 51L31 57V54Z", "#6d7f93") +
    path("M50 4L55 26L53 49L50 55L47 49L45 26Z", "#54677d") +
    circle(50, 16, 2.2, "#bfe0ee"),

  // Head-on. A locomotive in profile at this size is a red box on a wedge; from
  // the front the rails converge into it and it reads immediately.
  tauhoa: sky(C.sky) +
    rect(0, 44, 100, 16, "#c9c2b4") +
    path("M26 60L44 40H56L74 60Z", "#9aa3ad") +
    rect(30, 52, 40, 2, "#e4dccb") + rect(34, 46, 32, 2, "#e4dccb") +
    rect(46, 8, 8, 8, C.ink) +
    rect(34, 16, 32, 22, C.red) +
    rect(41, 21, 18, 8, "#cfe4ee") +
    path("M32 38H68L64 46H36Z", C.ink) +
    circle(50, 34, 2.6, C.gold),

  cangbien: sky(C.sky) +
    rect(0, 38, 100, 22, C.waterDeep) +
    path("M14 38H86L78 52H22Z", "#e4dccb") +
    rect(38, 22, 24, 16, C.wall) + rect(43, 26, 5, 5, C.water) + rect(53, 26, 5, 5, C.water) +
    rect(48, 10, 3, 12, C.ink) + circle(50, 8, 3, C.red),

  dienluc: sky(C.skyWarm) +
    rect(0, 50, 100, 10, C.land) +
    path("M50 6L38 50H44L50 22L56 50H62Z", C.ink) +
    line(28, 18, 72, 18, C.ink, 1) + line(24, 28, 76, 28, C.ink, 1) +
    path("M44 30L54 30L48 40L58 38L44 52L48 40L40 42Z", C.gold),

  // A droplet and a pipe. The first attempt drew a water tower, which at square
  // size is a house with a hat on.
  nuocsach: sky(C.sky) +
    rect(0, 48, 100, 12, C.land) +
    rect(0, 45, 100, 4, "#8e96a8") +
    rect(30, 41, 5, 8, "#78818c") + rect(66, 41, 5, 8, "#78818c") +
    // A drop is a point on top of a circle. Drawn as a lens it is a leaf.
    path("M50 6Q64 24 59 33A10 10 0 1 1 41 33Q36 24 50 6Z", C.waterDeep) +
    circle(46, 33, 3, "#bfe0ee") +
    circle(22, 38, 2.6, C.water) + circle(80, 34, 3.2, C.water),

  // --- the squares that are not places -------------------------------------
  xuatphat: sky("#dff0e0") +
    rect(0, 44, 100, 16, "#8fbb90") +
    rect(28, 12, 8, 8, C.ink) + rect(36, 20, 8, 8, C.ink) + rect(44, 12, 8, 8, C.ink) +
    rect(28, 20, 8, 8, C.white) + rect(36, 12, 8, 8, C.white) + rect(44, 20, 8, 8, C.white) +
    rect(26, 12, 2, 32, C.ink) +
    path("M62 24L78 32L62 40V34H54V30H62Z", "#2f9e5f"),

  nhatu: sky("#f0dcd8") +
    rect(20, 12, 60, 40, "#c9bda6") + rect(28, 20, 44, 26, "#6b7280") +
    rect(34, 20, 3, 26, "#e6e9ec") + rect(44, 20, 3, 26, "#e6e9ec") +
    rect(54, 20, 3, 26, "#e6e9ec") + rect(64, 20, 3, 26, "#e6e9ec") +
    rect(16, 52, 68, 4, "#a8998a"),

  // The same barred window as `nhatu`, with an arrow going in. A police cap at
  // this size is a dark circle, which says nothing; a door and an arrow do.
  vaotu: sky("#f0dcd8") +
    rect(46, 6, 46, 48, "#c9bda6") + rect(52, 13, 34, 34, "#6b7280") +
    rect(57, 13, 3, 34, "#e6e9ec") + rect(66, 13, 3, 34, "#e6e9ec") +
    rect(75, 13, 3, 34, "#e6e9ec") +
    rect(4, 26, 26, 8, C.red) + path("M28 20L46 30L28 40Z", C.red),

  dozxe: sky("#dfeaf6") +
    rect(0, 46, 100, 14, "#8e96a8") +
    circle(50, 26, 18, "#3f7f8f") +
    path("M43 16H54A8 8 0 0 1 54 30H49V38H43Z", C.white) +
    path("M49 21H54A3 3 0 0 1 54 25H49Z", "#3f7f8f"),

  cohoi: sky("#fbe7c8") +
    box(12, 16, 34, 34, 6, C.white, C.ink) +
    circle(23, 27, 3, C.ink) + circle(35, 39, 3, C.ink) +
    box(52, 22, 32, 32, 6, "#f3ece0", C.ink) +
    circle(61, 31, 2.8, C.red) + circle(68, 38, 2.8, C.red) + circle(75, 45, 2.8, C.red),

  khivan: sky("#fbe0dc") +
    rect(22, 16, 56, 34, C.red) +
    path("M22 16L50 36L78 16Z", "#a8352a") +
    circle(50, 34, 7, C.gold) +
    rect(48, 30, 4, 8, "#a8352a") + rect(45, 33, 10, 2.4, "#a8352a"),

  thue: sky("#eef1f4") +
    path("M28 8H72V48L64 44L56 50L48 44L40 50L32 44L28 48Z", C.white) +
    rect(36, 16, 28, 3, "#9aa3ad") + rect(36, 24, 28, 3, "#9aa3ad") +
    rect(36, 32, 18, 3, "#9aa3ad") +
    circle(70, 40, 9, "#3f7f8f") + rect(68, 34, 4, 12, C.white) +
    rect(65, 38, 10, 3, C.white),

  // --- the middle of the board ---------------------------------------------
  //
  // Emblems rather than squares: these are drawn to be looked at large, in the
  // hole in the middle of the board, and they carry the whole board's name.

  // A real outline rather than a freehand one: the coast and the borders are
  // plotted from longitude and latitude on a plain linear projection —
  // x = 20 + (lon − 100) × 5, y = 4 + (24 − lat) × 3.25 — so the country is the
  // shape people know instead of an S somebody drew from memory.
  bandovn: sky("#c4e2ef") +
    // Neighbours, kept pale: this is a picture of one country, not of a region.
    path(
      "M0 0H56L60 12L49 20L53 27L58 34L57 42L49 44L42 48L30 50L14 46L0 42Z",
      "#e0e7d5",
    ) +
    // The country. Clockwise from the north-west corner, down the coast, round
    // the delta, and back up the western border.
    path(
      "M31 9L47 6L54 8L60 12L54 15L52 17L50 20L52 24L56 27L62 30L66 37L68 42" +
        "L65 46L56 48L50 51L44 54L45 50L43 48L49 44L58 42L58 34L57 30L54 27" +
        "L49 23L43 18L40 14L35 12Z",
      "#8cbd72",
    ) +
    // The Trường Sơn, a narrow range down the western side of the waist.
    path("M49 23L54 27L57 30L58 34L58 42L55 41L55 33L53 29L50 26L46 22Z", "#6fa35d") +
    // The two deltas: flatter, greener, and where nearly everybody lives.
    path("M45 50L43 48L49 44L56 48L50 51L44 54Z", "#a8d38c") +
    path("M50 20L52 17L54 15L48 16L46 19Z", "#a8d38c") +
    // The coast, then a river out of each delta.
    curve("M60 12L52 17L50 20L52 24L56 27L62 30L66 37L68 42L65 46", C.white, 0.9) +
    curve("M45 13Q48 15 51 16", "#7fc0dc", 0.9) +
    curve("M48 45Q50 47 51 49", "#7fc0dc", 0.9) +
    curve("M46 47Q46 50 45 52", "#7fc0dc", 0.8) +
    // Phú Quốc and Côn Đảo, then Hoàng Sa and Trường Sa — where they belong on
    // any map of this country.
    circle(40, 49, 1.2, "#8cbd72") + circle(53, 54, 0.9, "#8cbd72") +
    circle(74, 28, 1.7, "#8cbd72") + circle(78, 31, 1.1, "#8cbd72") +
    circle(72, 46, 1.5, "#8cbd72") + circle(76, 49, 1, "#8cbd72") +
    circle(70, 51, 0.9, "#8cbd72") +
    // The flag, as a corner badge out over the sea, where it covers no land.
    box(4, 4, 17, 12, 1.6, C.red) + star(12.5, 10, 4.2, C.gold),
};

export const SCENE_KEYS = Object.keys(SCENES);

/**
 * The picture a square gets when its board file does not name one.
 *
 * Fixed squares are decided by kind, because there is exactly one sensible
 * drawing for "go to jail". Places fall back to a rotation through a handful of
 * generic Vietnamese scenes, keyed by position — so a hand-written board with no
 * `scene` fields at all still comes out looking like a board rather than like
 * forty copies of the same picture, and the same board always looks the same.
 */
const BY_KIND = {
  go: "xuatphat",
  jail: "nhatu",
  gotojail: "vaotu",
  parking: "dozxe",
  chance: "cohoi",
  chest: "khivan",
  tax: "thue",
};

const PLACE_ROTATION = [
  "duongpho",
  "phoco",
  "cho",
  "hocuoc",
  "bien",
  "chua",
  "nui",
  "dothi",
  "songnuoc",
  "denlong",
  "che",
  "cauvong",
];

const TRANSPORT_ROTATION = ["sanbay", "tauhoa", "cangbien", "sanbay"];
const UTILITY_ROTATION = ["dienluc", "nuocsach"];

/**
 * Resolve the scene for one square.
 *
 * @param kind The square's kind.
 * @param named What the board file asked for, if anything.
 * @param nth Which place/transport/utility this is, for the rotation.
 * @returns A key that is certainly in SCENES.
 */
export function sceneFor(kind, named, nth = 0) {
  if (typeof named === "string" && Object.hasOwn(SCENES, named)) return named;
  if (kind === "place") return PLACE_ROTATION[nth % PLACE_ROTATION.length];
  if (kind === "transport") return TRANSPORT_ROTATION[nth % TRANSPORT_ROTATION.length];
  if (kind === "utility") return UTILITY_ROTATION[nth % UTILITY_ROTATION.length];
  return BY_KIND[kind] ?? "duongpho";
}

/**
 * The scene as SVG markup, ready to drop into an element.
 *
 * `slice` by default, so one drawing serves both places a square's picture
 * appears: cropped to the middle in a square board cell, filling the frame on a
 * wide deed card. No `width`/`height` — the wrapper decides, which is what keeps
 * the board fluid.
 *
 * `fit: "meet"` shows all of the drawing instead of cropping it, and is what the
 * emblem in the middle of the board uses. The middle is square and these are
 * drawn 5:3, so `slice` there would blow one scene up to 780 pixels and then cut
 * its edges off — fine for a thumb-sized cell, clumsy at that size.
 */
export function sceneSvg(key, fit = "slice") {
  const inner = SCENES[key] ?? SCENES.duongpho;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" ` +
    `preserveAspectRatio="xMidYMid ${fit}" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/**
 * The picture for the middle of the board.
 *
 * A board says what its emblem is; a board that does not gets the picture from
 * its dearest square, which on any board written by a person is the landmark
 * they would have picked anyway.
 */
export function emblemFor(named, dearestScene) {
  if (typeof named === "string" && Object.hasOwn(SCENES, named)) return named;
  if (typeof dearestScene === "string" && Object.hasOwn(SCENES, dearestScene)) {
    return dearestScene;
  }
  return "dothi";
}

/**
 * A die face, drawn.
 *
 * ⚀–⚅ exist and were what this used, but at the size a die is actually shown
 * they are a hairline outline with pips too small to count — in a screenshot of
 * the real board they read as two empty boxes. The dice are the one thing on
 * this screen that everybody at the table is watching, so they are drawn rather
 * than typed, like everything else on the board.
 *
 * The body follows the page's own colours: inline SVG can read the same custom
 * properties the rest of the page does, so one drawing is right in both themes.
 */
const PIPS = {
  1: [[50, 50]],
  2: [[30, 30], [70, 70]],
  3: [[30, 30], [50, 50], [70, 70]],
  4: [[30, 30], [70, 30], [30, 70], [70, 70]],
  5: [[30, 30], [70, 30], [50, 50], [30, 70], [70, 70]],
  6: [[30, 26], [70, 26], [30, 50], [70, 50], [30, 74], [70, 74]],
};

export function dieSvg(face) {
  const pips = PIPS[face] ?? PIPS[1];
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">` +
    `<rect x="3" y="3" width="94" height="94" rx="20" fill="var(--surface, #fff)" ` +
    `stroke="var(--border, #d8d2c6)" stroke-width="6"/>` +
    pips.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="10" fill="currentColor"/>`).join("") +
    `</svg>`;
}
