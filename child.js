// Frame script source. Read by the PARENT process and shipped to content as a
// data: URI — the content sandbox blocks reads of ~/.vimfox, so nothing here
// may be loaded from disk by the content process itself.
//
// Runs with system privileges in the content process, on every document
// including about:*, view-source:, and extension pages.

"use strict";

const NON_TEXT_INPUTS = new Set([
  "button", "checkbox", "radio", "submit", "reset",
  "file", "image", "color", "range",
]);

function isEditable() {
  const doc = content?.document;
  if (!doc) return false;
  if (doc.designMode === "on") return true;

  const el = doc.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;

  const tag = el.localName;
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    return !NON_TEXT_INPUTS.has((el.type || "text").toLowerCase());
  }
  return false;
}

// A page autofocusing its search box (about:newtab is the worst offender)
// must not drag us into insert mode. Only focus that follows a real user
// gesture counts — qutebrowser's input.insert_mode.auto_load = false.
let lastGesture = 0;
const GESTURE_WINDOW_MS = 300;

function markGesture() {
  lastGesture = Date.now();
}

addEventListener("mousedown", markGesture, true);
addEventListener("keydown", markGesture, true);

function report() {
  sendAsyncMessage("VimFox:Focus", {
    editable: isEditable(),
    userInitiated: Date.now() - lastGesture < GESTURE_WINDOW_MS,
  });
}

addEventListener("focusin", report, true);
addEventListener("focusout", report, true);

// In normal mode the page gets no keys at all. Our own bindings are reserved
// chrome keys, handled in the parent before content is consulted, so they are
// unaffected — this only kills the leak of everything we do NOT bind (Google's
// "/" and "?" shortcuts being the obvious case).
let swallowKeys = false;

addMessageListener("VimFox:Mode", (msg) => {
  swallowKeys = msg.data.mode === "normal";
});

// Registered after markGesture so that still runs; stopImmediatePropagation
// only blocks listeners added after this one, which is every page script,
// since actor scripts run at DOMWindowCreated.
for (const type of ["keydown", "keypress", "keyup"]) {
  addEventListener(
    type,
    (e) => {
      if (!swallowKeys) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
}

// A freshly loaded frame has no idea what mode the window is in.
sendAsyncMessage("VimFox:Ready", {});

// Escape in insert mode: drop focus so the page stops receiving keys.
addMessageListener("VimFox:Blur", () => {
  // Escape is a reserved chrome key, so it is consumed in the parent and never
  // reaches the frame script's own keydown listener — the gi overlays would
  // otherwise stay on screen. Tear them down from here instead.
  exitFocusSelector();

  const el = content?.document?.activeElement;
  if (el && el !== content.document.body) el.blur();
  report();
});

// h/l — horizontal scroll. Firefox has no cmd_scroll{Left,Right} to borrow,
// unlike the vertical ones, so this is the one scroll that needs content code.
addMessageListener("VimFox:ScrollX", (msg) => {
  content?.scrollBy({ left: msg.data.dx, top: 0, behavior: "instant" });
});

// gi — Vimium's focusInput (content_scripts/mode_normal.js). Focus the first
// visible text input, outline every one of them, and let Tab cycle between
// them until any other key is pressed.

// The <input type="..."> values Vimium considers, from textInputXPath.
const TEXT_INPUT_TYPES = new Set([
  "text", "search", "email", "url", "number", "password", "date", "tel",
]);

function visibleTextInputs() {
  const doc = content.document;
  const all = [...doc.querySelectorAll("input, textarea, [contenteditable]")];

  const inputs = all.filter((el) => {
    if (el.disabled || el.readOnly) return false;
    if (el.localName === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (!TEXT_INPUT_TYPES.has(type)) return false;
    } else if (el.localName !== "textarea") {
      const ce = (el.getAttribute("contenteditable") || "").toLowerCase();
      if (ce !== "" && ce !== "true") return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = content.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  });

  // Vimium's ordering: positive tabIndex first, by tabIndex, then DOM order.
  return inputs
    .map((element, index) => ({ element, index }))
    .sort((a, b) => {
      const ta = a.element.tabIndex, tb = b.element.tabIndex;
      if (ta > 0 && tb > 0) return ta - tb || a.index - b.index;
      if (ta > 0) return -1;
      if (tb > 0) return 1;
      return a.index - b.index;
    })
    .map((t) => t.element);
}

// DomUtils.simulateSelect: focus, and if the caret sits at the very start of a
// single-line field, send it to the end — a more useful place to resume.
function simulateSelect(el) {
  el.focus();
  if (el.localName === "textarea" && (el.value ?? "").includes("\n")) return;
  try {
    if (el.selectionStart === 0 && el.selectionEnd === 0) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  } catch {
    // Some input types throw on selection access.
  }
}

// Vimium styles these via a stylesheet plus a big CSS reset; inline styles get
// the same look without shipping the reset or risking page CSS overriding it.
const HINT_BASE =
  "position:absolute;display:block;pointer-events:none;z-index:2139999998;" +
  "border-style:solid;border-width:1px;";

// Vimium's two states. Applied as individual properties, never by rewriting
// cssText — the browser normalises cssText on assignment, so string-replacing
// a style fragment back out of it silently fails and the old hint stays red.
function paintHint(hint, selected) {
  hint.style.backgroundColor = selected
    ? "rgba(255,102,102,0.3)"
    : "rgba(255,247,133,0.3)";
  hint.style.borderColor = selected ? "#993333" : "#c38a22";
}

let focusSelector = null;

function exitFocusSelector() {
  if (!focusSelector) return;
  removeEventListener("keydown", focusSelector.onKeydown, true);
  removeEventListener("click", exitFocusSelector, true);
  focusSelector.container.remove();
  focusSelector = null;
}

addMessageListener("VimFox:FocusInput", () => {
  if (!content?.document) return;
  // gi is deliberate, but its keypress was consumed in the parent, so content
  // saw no gesture. Vouch for it or the focus below reads as page-initiated.
  markGesture();
  exitFocusSelector();

  const inputs = visibleTextInputs();
  if (!inputs.length) return;

  simulateSelect(inputs[0]);
  // One input: nothing to cycle between, so no overlays.
  if (inputs.length === 1) return;

  const doc = content.document;
  const container = doc.createElement("div");
  container.style.cssText = "all:initial;";

  const hints = inputs.map((el) => {
    const r = el.getBoundingClientRect();
    const hint = doc.createElement("div");
    hint.style.cssText =
      HINT_BASE +
      `left:${r.left - 1 + content.scrollX}px;top:${r.top - 1 + content.scrollY}px;` +
      `width:${r.width}px;height:${r.height}px;`;
    paintHint(hint, false);
    container.append(hint);
    return hint;
  });

  let i = 0;
  paintHint(hints[0], true);
  doc.documentElement.append(container);

  const onKeydown = (event) => {
    if (event.key === "Tab") {
      paintHint(hints[i], false);
      i = (i + hints.length + (event.shiftKey ? -1 : 1)) % hints.length;
      paintHint(hints[i], true);
      simulateSelect(inputs[i]);
      event.preventDefault();
      event.stopImmediatePropagation();
    } else if (event.key !== "Shift") {
      // Any other key ends cycling and is left to reach the input.
      exitFocusSelector();
    }
  };

  focusSelector = { container, onKeydown };
  addEventListener("keydown", onKeydown, true);
  addEventListener("click", exitFocusSelector, true);
});
