// Personal appearance, applied and stored in this browser only.
//
// Nothing here is sent to the server or shared with the room. Two people in the
// same game can be looking at completely different workspaces.

import { cssVarsFor, DEFAULT_PREFS, resolveMode, sanitisePrefs } from "/shared/prefs.js";

const STORAGE_KEY = "closeword.prefs";

/** @type {typeof DEFAULT_PREFS} */
let prefs = { ...DEFAULT_PREFS };
const listeners = new Set();

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    // Corrupt or unavailable storage is not worth a broken page.
    return null;
  }
}

function write() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota (a large custom background) or private browsing. The look still
    // applies for this session; it just will not survive a reload.
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export function currentMode() {
  return resolveMode(prefs.mode, darkQuery.matches);
}

function apply() {
  const root = document.documentElement;
  const mode = currentMode();

  // data-theme drives the colour tokens in styles.css; the rest are hooks for
  // layout and density rules.
  root.dataset.theme = mode;
  root.dataset.layout = prefs.layout;
  root.dataset.density = prefs.density;
  root.dataset.glass = prefs.glass ? "on" : "off";
  root.dataset.motion = prefs.motion ? "on" : "off";

  for (const [name, value] of Object.entries(cssVarsFor(prefs, mode))) {
    root.style.setProperty(name, value);
  }
  for (const fn of listeners) fn(prefs);
}

/** Re-resolve "system" when the OS flips between light and dark. */
darkQuery.addEventListener("change", () => {
  if (prefs.mode === "system") apply();
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getPrefs() {
  return { ...prefs };
}

/**
 * Apply a validated patch. Returns what changed and what was refused, so a
 * caller can tell the player "I ignored that bit" instead of failing silently.
 *
 * @param {Record<string, unknown>} patch
 */
export function updatePrefs(patch) {
  const result = sanitisePrefs(patch, prefs);
  prefs = result.prefs;
  write();
  apply();
  return result;
}

export function resetPrefs() {
  prefs = { ...DEFAULT_PREFS };
  write();
  apply();
  return prefs;
}

/** Called on every applied change; used by the settings UI to stay in sync. */
export function onPrefsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * What we are willing to tell `claude -p` about the current look. Deliberately
 * excludes `backgroundImage`: a player's own photo has no business leaving their
 * machine, and a multi-megabyte data URI in a prompt would be useless anyway.
 */
export function prefsForPrompt() {
  const { backgroundImage: _ignored, ...rest } = prefs;
  return { ...rest, hasCustomImage: Boolean(prefs.backgroundImage) };
}

/**
 * Downscale a chosen image and store it as a data URI. Kept well under the
 * localStorage quota — a 4000px phone photo would otherwise fail to save and the
 * background would silently vanish on the next reload.
 *
 * @param {File} file
 * @param {number} [maxEdge]
 */
export async function imageToDataUri(file, maxEdge = 1920) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  // JPEG rather than PNG: a photographic background at PNG quality routinely
  // blows past the 5 MB storage limit.
  return canvas.toDataURL("image/jpeg", 0.82);
}

// Restore before first paint so there is no flash of the default theme.
const stored = read();
if (stored) prefs = sanitisePrefs(stored, DEFAULT_PREFS).prefs;
apply();
