// Tiny DOM helpers. No framework: the whole UI is a handful of regions that get
// rebuilt from a state snapshot, and the one thing that must survive a rebuild
// (the guess input) is created once and never re-rendered.

import { formatRankValue } from "/shared/constants.js";

/**
 * Create an element. `spec` may set attributes, `class`, `text`, `html`, and any
 * `on*` handler. Children can be nodes, strings, or nested arrays; null and
 * false are skipped so `cond && el(...)` works inline.
 */
export function el(tag, spec = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(spec)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "value") node.value = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === "") continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/** Replace a region's contents in one go. */
export function fill(parent, children) {
  parent.replaceChildren();
  append(parent, children);
}

export function $(id) {
  return document.getElementById(id);
}

/** "2:05", or "0:07" — used for round countdowns. */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * How a rank is shown. Beyond RANK_DISPLAY_CAP it becomes "30000+", as closeword
 * does — past that point the precise figure is unusable and only looks precise.
 */
export function formatRank(rank) {
  return rank === 1 ? "FOUND" : formatRankValue(rank);
}

/**
 * How full a guess row's proximity bar should be. Ranks are wildly non-linear —
 * rank 20 and rank 20,000 are both "a number" — so we scale logarithmically,
 * which makes the last stretch toward the answer feel like progress.
 */
export function proximityPercent(rank, vocabSize) {
  if (rank <= 1) return 100;
  const span = Math.log(Math.max(vocabSize, 10));
  const value = 1 - Math.log(rank) / span;
  return Math.max(2, Math.min(100, Math.round(value * 100)));
}

export function relativeTime(at, now) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
