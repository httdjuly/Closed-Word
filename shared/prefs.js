// Per-player appearance preferences.
//
// These live in the player's own browser (localStorage) and are never sent to
// the server or to other players — everyone in a room can look at a completely
// different workspace while playing the same game.
//
// This file is the single authority on what may be customised. It matters
// because preferences can arrive from `claude -p` via the chatbot, so every
// value crosses a trust boundary: the model proposes, this schema decides. The
// rules are deliberately narrow — enums, clamped numbers, hex colours, and
// data-URI images only. Nothing here ever becomes raw CSS.

/** @typedef {"system" | "light" | "dark"} ThemeMode */
/** @typedef {"columns" | "focus" | "wide"} Layout */
/** @typedef {"compact" | "cozy" | "roomy"} Density */
/** @typedef {"system" | "rounded" | "serif" | "mono"} FontChoice */

export const THEME_MODES = ["system", "light", "dark"];
export const LAYOUTS = ["columns", "focus", "wide"];
export const DENSITIES = ["compact", "cozy", "roomy"];
export const FONTS = ["system", "rounded", "serif", "mono"];

export const RADIUS_RANGE = { min: 2, max: 28 };
/** A data-URI background beyond this would blow the localStorage quota. */
export const MAX_BACKGROUND_BYTES = 3_000_000;

export const FONT_STACKS = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  rounded:
    'ui-rounded, "SF Pro Rounded", "Segoe UI Variable Display", "Nunito", system-ui, sans-serif',
  serif: 'Iowan Old Style, "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
};

/**
 * Background scenes. Every one is pure CSS or an inline data URI, so a workspace
 * never makes a network request to paint itself — no third party learns what
 * anyone is playing, and it all still works on a laptop with no internet.
 */
export const BACKGROUNDS = {
  clay: {
    label: "Clay",
    light: "radial-gradient(1200px 700px at 12% -8%, #f7e3d6 0%, transparent 60%)," +
      "radial-gradient(1000px 600px at 92% 8%, #ece6f7 0%, transparent 58%)," +
      "linear-gradient(170deg, #faf9f5 0%, #f2efe7 100%)",
    dark: "radial-gradient(1100px 640px at 10% -10%, #3a2723 0%, transparent 60%)," +
      "radial-gradient(900px 560px at 94% 6%, #232a3d 0%, transparent 58%)," +
      "linear-gradient(170deg, #1a1917 0%, #131311 100%)",
  },
  aurora: {
    label: "Aurora",
    light: "radial-gradient(900px 520px at 78% -6%, #d8f2ea 0%, transparent 60%)," +
      "radial-gradient(820px 520px at 8% 12%, #dbe6fb 0%, transparent 60%)," +
      "linear-gradient(160deg, #f7fbfa 0%, #eef2f8 100%)",
    dark: "radial-gradient(1000px 560px at 76% -6%, #15413c 0%, transparent 62%)," +
      "radial-gradient(880px 540px at 6% 10%, #1b2a4d 0%, transparent 60%)," +
      "linear-gradient(160deg, #0e1418 0%, #0b1016 100%)",
  },
  dusk: {
    label: "Dusk",
    light: "radial-gradient(1000px 600px at 50% -10%, #ffe0c7 0%, transparent 62%)," +
      "linear-gradient(180deg, #f4ecfa 0%, #e8e9f6 100%)",
    dark: "radial-gradient(1100px 620px at 50% -12%, #4a2b3f 0%, transparent 62%)," +
      "linear-gradient(180deg, #191627 0%, #0f0e18 100%)",
  },
  forest: {
    label: "Forest",
    light: "radial-gradient(900px 520px at 20% 0%, #e2f0dc 0%, transparent 60%)," +
      "linear-gradient(170deg, #f6faf4 0%, #eaf1e7 100%)",
    dark: "radial-gradient(950px 540px at 18% -4%, #1d3326 0%, transparent 62%)," +
      "linear-gradient(170deg, #101613 0%, #0c110e 100%)",
  },
  skyline: {
    label: "Skyline",
    // A flat SVG cityscape, echoing the glass-over-a-city look. Inline so it
    // costs no request; `#` is percent-encoded because it is inside a url().
    light: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' " +
      "viewBox='0 0 1600 900' preserveAspectRatio='xMidYMax slice'%3E%3Cdefs%3E" +
      "%3ClinearGradient id='s' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' " +
      "stop-color='%23cfe0f2'/%3E%3Cstop offset='1' stop-color='%23f3ece4'/%3E" +
      "%3C/linearGradient%3E%3C/defs%3E%3Crect width='1600' height='900' fill='url(%23s)'/%3E" +
      "%3Cg fill='%23aebfd4' opacity='.55'%3E%3Crect x='40' y='520' width='120' height='380'/%3E" +
      "%3Crect x='185' y='430' width='90' height='470'/%3E%3Crect x='300' y='560' width='140' height='340'/%3E" +
      "%3Crect x='465' y='360' width='110' height='540'/%3E%3Crect x='600' y='480' width='95' height='420'/%3E" +
      "%3Crect x='720' y='300' width='130' height='600'/%3E%3Crect x='875' y='450' width='100' height='450'/%3E" +
      "%3Crect x='1000' y='390' width='120' height='510'/%3E%3Crect x='1145' y='540' width='105' height='360'/%3E" +
      "%3Crect x='1275' y='420' width='125' height='480'/%3E%3Crect x='1425' y='500' width='135' height='400'/%3E" +
      '%3C/g%3E%3C/svg%3E"), linear-gradient(180deg, #dfe9f4 0%, #f3ece4 100%)',
    dark: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' " +
      "viewBox='0 0 1600 900' preserveAspectRatio='xMidYMax slice'%3E%3Cdefs%3E" +
      "%3ClinearGradient id='s' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' " +
      "stop-color='%230d1725'/%3E%3Cstop offset='1' stop-color='%23131a24'/%3E" +
      "%3C/linearGradient%3E%3C/defs%3E%3Crect width='1600' height='900' fill='url(%23s)'/%3E" +
      "%3Cg fill='%231d2a3d' opacity='.9'%3E%3Crect x='40' y='520' width='120' height='380'/%3E" +
      "%3Crect x='185' y='430' width='90' height='470'/%3E%3Crect x='300' y='560' width='140' height='340'/%3E" +
      "%3Crect x='465' y='360' width='110' height='540'/%3E%3Crect x='600' y='480' width='95' height='420'/%3E" +
      "%3Crect x='720' y='300' width='130' height='600'/%3E%3Crect x='875' y='450' width='100' height='450'/%3E" +
      "%3Crect x='1000' y='390' width='120' height='510'/%3E%3Crect x='1145' y='540' width='105' height='360'/%3E" +
      "%3Crect x='1275' y='420' width='125' height='480'/%3E%3Crect x='1425' y='500' width='135' height='400'/%3E" +
      "%3C/g%3E%3Cg fill='%23f0c98a' opacity='.5'%3E%3Crect x='500' y='400' width='8' height='10'/%3E" +
      "%3Crect x='530' y='430' width='8' height='10'/%3E%3Crect x='760' y='340' width='8' height='10'/%3E" +
      "%3Crect x='800' y='380' width='8' height='10'/%3E%3Crect x='1040' y='430' width='8' height='10'/%3E" +
      "%3Crect x='1310' y='470' width='8' height='10'/%3E%3C/g%3E%3C/svg%3E\"), " +
      "linear-gradient(180deg, #0d1725 0%, #131a24 100%)",
  },
  paper: {
    label: "Paper",
    light: "linear-gradient(180deg, #fbfaf7 0%, #f4f2ec 100%)",
    dark: "linear-gradient(180deg, #1b1b19 0%, #141413 100%)",
  },
  solid: { label: "Solid colour", light: null, dark: null },
  custom: { label: "Your own image", light: null, dark: null },
};

/**
 * Annotated rather than inferred: without this, `backgroundImage: null` narrows
 * to the type `null`, and every caller that sets an image fails to type-check.
 *
 * @typedef {object} AppearancePrefs
 * @property {ThemeMode} mode
 * @property {string} accent
 * @property {string} background
 * @property {string} backgroundColor
 * @property {string | null} backgroundImage
 * @property {Layout} layout
 * @property {Density} density
 * @property {FontChoice} font
 * @property {boolean} glass
 * @property {number} radius
 * @property {boolean} motion
 */

/** @type {AppearancePrefs} */
export const DEFAULT_PREFS = {
  mode: "system",
  /** Claude clay. */
  accent: "#c96442",
  background: "clay",
  /** Used when background is "solid". */
  backgroundColor: "#f5f3ee",
  /** Data URI, only when background is "custom". */
  backgroundImage: null,
  layout: "columns",
  density: "cozy",
  font: "system",
  glass: true,
  radius: 14,
  motion: true,
};

/** Named looks, so "make it calmer" has somewhere concrete to land. */
export const PRESETS = {
  claude: {
    label: "Claude",
    hint: "Warm clay on paper — the default.",
    prefs: { accent: "#c96442", background: "clay", font: "system", glass: true, radius: 14 },
  },
  midnight: {
    label: "Midnight",
    hint: "Dark glass over a city at night.",
    prefs: { mode: "dark", accent: "#7c9cff", background: "skyline", glass: true, radius: 16 },
  },
  meadow: {
    label: "Meadow",
    hint: "Soft greens, rounded type.",
    prefs: { mode: "light", accent: "#3f8f5f", background: "forest", font: "rounded", radius: 20 },
  },
  focus: {
    label: "Focus",
    hint: "One column, flat surfaces, no distractions.",
    prefs: { background: "paper", glass: false, layout: "focus", density: "compact", radius: 8 },
  },
  arcade: {
    label: "Arcade",
    hint: "Loud accent, big corners.",
    prefs: { mode: "dark", accent: "#e0518f", background: "dusk", font: "rounded", radius: 24 },
  },
};

const HEX_RE = /^#[0-9a-f]{6}$/i;
/**
 * Uploads and AI suggestions may only be raster data URIs. Remote URLs are
 * refused outright: a `url(https://...)` would turn a cosmetic preference into a
 * request to someone else's server every time the page painted. SVG is refused
 * too — it is a document format, and we have no reason to accept one here.
 */
const DATA_URI_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i;

function pickEnum(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function pickHex(value, fallback) {
  return typeof value === "string" && HEX_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

function pickBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function pickRadius(value, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(RADIUS_RANGE.max, Math.max(RADIUS_RANGE.min, n));
}

function pickBackgroundImage(value, fallback) {
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!DATA_URI_RE.test(trimmed)) return fallback;
  if (trimmed.length > MAX_BACKGROUND_BYTES) return fallback;
  return trimmed;
}

/**
 * Validate a partial patch against `base`. Returns the merged preferences plus
 * the keys that were rejected, so the UI can say what it declined rather than
 * silently ignoring half of a request.
 *
 * @param {unknown} patch
 * @param {Partial<AppearancePrefs>} [base]
 */
export function sanitisePrefs(patch, base = DEFAULT_PREFS) {
  const merged = { ...DEFAULT_PREFS, ...base };
  const rejected = [];
  if (!patch || typeof patch !== "object") return { prefs: merged, rejected, applied: [] };

  const applied = [];
  /** Assign only if the validated value differs from what we started with. */
  const take = (key, value) => {
    if (!(key in patch)) return;
    if (value === undefined) {
      rejected.push(key);
      return;
    }
    // A validator that fell back to the current value means the input was junk.
    if (value === merged[key] && !deepEquals(patch[key], value)) {
      rejected.push(key);
      return;
    }
    if (value !== merged[key]) applied.push(key);
    merged[key] = value;
  };

  take("mode", pickEnum(patch.mode, THEME_MODES, merged.mode));
  take("accent", pickHex(patch.accent, merged.accent));
  take("background", pickEnum(patch.background, Object.keys(BACKGROUNDS), merged.background));
  take("backgroundColor", pickHex(patch.backgroundColor, merged.backgroundColor));
  take("backgroundImage", pickBackgroundImage(patch.backgroundImage, merged.backgroundImage));
  take("layout", pickEnum(patch.layout, LAYOUTS, merged.layout));
  take("density", pickEnum(patch.density, DENSITIES, merged.density));
  take("font", pickEnum(patch.font, FONTS, merged.font));
  take("glass", pickBool(patch.glass, merged.glass));
  take("radius", pickRadius(patch.radius, merged.radius));
  take("motion", pickBool(patch.motion, merged.motion));

  // Anything we do not recognise is reported rather than quietly dropped.
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULT_PREFS) && key !== "preset") rejected.push(key);
  }

  // A preset is shorthand for a bundle of the fields above.
  if (typeof patch.preset === "string") {
    const preset = PRESETS[patch.preset];
    if (preset) {
      const withPreset = sanitisePrefs(preset.prefs, merged);
      return {
        prefs: withPreset.prefs,
        rejected,
        applied: [...new Set([...applied, ...withPreset.applied])],
      };
    }
    rejected.push("preset");
  }

  // "custom" without an image would paint nothing at all.
  if (merged.background === "custom" && !merged.backgroundImage) {
    merged.background = DEFAULT_PREFS.background;
    rejected.push("background");
  }

  return { prefs: merged, rejected: [...new Set(rejected)], applied };
}

function deepEquals(a, b) {
  return a === b ||
    (typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase());
}

/** Relative luminance, for deciding what colour text sits on the accent. */
export function luminance(hex) {
  const m = HEX_RE.test(hex) ? hex.slice(1) : "808080";
  const channel = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(m.slice(0, 2)) + 0.7152 * channel(m.slice(2, 4)) +
    0.0722 * channel(m.slice(4, 6));
}

/**
 * Text colour to sit on top of `hex`. Without this, a player who asks for a pale
 * yellow accent gets white-on-yellow buttons they cannot read.
 */
export function readableOn(hex) {
  return luminance(hex) > 0.5 ? "#17150f" : "#ffffff";
}

const DENSITY_SCALE = { compact: 0.78, cozy: 1, roomy: 1.28 };

/**
 * The CSS custom properties implied by a set of preferences. Kept here rather
 * than in the client so it is testable and so there is one definition of how a
 * preference becomes a pixel.
 *
 * @param {Partial<AppearancePrefs>} prefs
 * @param {"light" | "dark"} resolvedMode
 */
export function cssVarsFor(prefs, resolvedMode) {
  const scene = BACKGROUNDS[prefs.background] ?? BACKGROUNDS.clay;
  let image = scene[resolvedMode] ?? null;
  if (prefs.background === "solid") image = prefs.backgroundColor;
  if (prefs.background === "custom" && prefs.backgroundImage) {
    image = `url("${prefs.backgroundImage}")`;
  }
  return {
    "--accent": prefs.accent,
    "--accent-text": readableOn(prefs.accent),
    "--radius": `${prefs.radius}px`,
    "--radius-sm": `${Math.max(2, Math.round(prefs.radius * 0.55))}px`,
    "--space-scale": String(DENSITY_SCALE[prefs.density] ?? 1),
    "--font-ui": FONT_STACKS[prefs.font] ?? FONT_STACKS.system,
    "--scene": image ?? "none",
    "--glass-blur": prefs.glass ? "14px" : "0px",
    "--surface-alpha": prefs.glass ? "0.72" : "1",
  };
}

/** Resolve "system" against the viewer's OS setting. */
export function resolveMode(mode, prefersDark) {
  if (mode === "light" || mode === "dark") return mode;
  return prefersDark ? "dark" : "light";
}
