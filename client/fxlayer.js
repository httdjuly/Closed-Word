// The one full-screen layer that transient effects are drawn into.
//
// Shared by the throwables and the buzz card so there is a single stacking
// context to reason about: created on demand, `pointer-events: none`, and
// deliberately *below* the toasts, dialogs and the journey drawer. An egg or a
// BUZZ card is never more important than a question somebody is waiting on an
// answer to.

/** @returns {HTMLElement} */
export function fxLayer() {
  let node = document.getElementById("fxLayer");
  if (!node) {
    node = document.createElement("div");
    node.id = "fxLayer";
    // Everything drawn here is decoration or duplicated in the feed and the
    // toasts, so a screen reader should walk straight past it.
    node.setAttribute("aria-hidden", "true");
    document.body.appendChild(node);
  }
  return node;
}
