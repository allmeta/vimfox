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
// Clicks are timestamped SEPARATELY from keys. Leaving insert mode is
// click-driven in qutebrowser (input.insert_mode.auto_leave hangs off
// mousePress in eventfilter.py), and a keystroke that makes the page move
// focus itself must not count as one.
let lastClick = 0;
const GESTURE_WINDOW_MS = 300;

function markGesture() {
  lastGesture = Date.now();
}

function markClick() {
  lastClick = lastGesture = Date.now();
}

addEventListener("mousedown", markClick, true);
addEventListener("keydown", markGesture, true);

function report() {
  const at = Date.now();
  sendAsyncMessage("VimFox:Focus", {
    editable: isEditable(),
    userInitiated: at - lastGesture < GESTURE_WINDOW_MS,
    clicked: at - lastClick < GESTURE_WINDOW_MS,
  });
}

// Coalesced to the end of the turn. focusout fires with activeElement already
// back on <body>, so reporting it directly said "not editable" and the parent
// dropped to normal mode; the focusin that followed was then gated out as
// page-initiated, stranding you in normal with a field focused and every key
// swallowed. Deferring lets a focusout+focusin pair settle into ONE report of
// the final state — which is the same reason the parent listens to focus and
// never to blur.
let reportPending = false;
function scheduleReport() {
  if (reportPending) return;
  reportPending = true;
  Services.tm.dispatchToMainThread(() => {
    reportPending = false;
    report();
  });
}

addEventListener("focusin", scheduleReport, true);
addEventListener("focusout", scheduleReport, true);

// Selecting text puts the window in caret mode, where `y` yanks. Only the
// has/has-not TRANSITION is reported: selectionchange fires on every mouse move
// while a selection is being dragged out, and the parent needs one boolean.
// The text itself never crosses the process boundary — cmd_copy is routed here.
//
// mouseup/keyup as well as selectionchange: the latter is not fired for every
// way a selection can end, and the transition guard makes the extra calls free.
let hadSelection = false;

function reportSelection() {
  const sel = content?.getSelection?.();
  const has =
    !!sel && !sel.isCollapsed && !!sel.toString().trim() && !isEditable();
  if (has === hadSelection) return;
  hadSelection = has;
  sendAsyncMessage("VimFox:Selection", { hasSelection: has });
}

for (const type of ["selectionchange", "mouseup", "keyup"]) {
  addEventListener(type, reportSelection, true);
}

// qutebrowser's `o` — swap the stationary and moving end of the selection.
// Gecko has no command for it, but the Selection API does it directly: the
// anchor is the stationary end, the focus is the one motions move.
addMessageListener("VimFox:ReverseSelection", () => {
  try {
    const sel = content?.getSelection?.();
    if (!sel || sel.isCollapsed) return;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = sel;
    sel.setBaseAndExtent(focusNode, focusOffset, anchorNode, anchorOffset);
  } catch (ex) {
    // Cross-origin or torn-down frame; nothing to swap.
  }
});

addMessageListener("VimFox:ClearSelection", () => {
  try {
    content?.getSelection?.()?.removeAllRanges();
  } catch (ex) {
    // A cross-origin or torn-down frame: nothing to clear.
  }
  reportSelection();
});

// In normal mode the page gets no keys at all. Our own bindings are reserved
// chrome keys, handled in the parent before content is consulted, so they are
// unaffected — this only kills the leak of everything we do NOT bind (Google's
// "/" and "?" shortcuts being the obvious case).
let swallowKeys = false;

addMessageListener("VimFox:Mode", (msg) => {
  // Which modes swallow is the parent's MODES table to decide, not ours —
  // content keeping its own copy is how the two drift apart.
  swallowKeys = !!msg.data.swallow;
});

// Keys normal mode does NOT swallow.
//
// Scrolling: we bind no arrows, so scrolling them is the page's own default
// action. Swallowing them just meant nothing scrolled.
//
// Function keys and Ctrl+Shift chords: these are Firefox's, and unlike ours
// they are NOT reserved — a non-reserved chrome key is processed AFTER content,
// so preventDefault here killed them outright. That is why F12 and
// Ctrl+Shift+C did nothing in normal mode.
const SCROLL_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End", " ",
]);

function passThrough(e) {
  if (/^F\d{1,2}$/.test(e.key)) return true;
  if (e.ctrlKey && e.shiftKey && !e.altKey) return true;
  // Ctrl+C copies the selection. Handled by letting Firefox's own key_copy see
  // it rather than by binding it: nothing of ours has to know about the
  // selection, and Ctrl+C keeps working exactly as it does everywhere else.
  if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "c" || e.key === "C")) {
    return true;
  }
  return SCROLL_KEYS.has(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey;
}

// Registered after markGesture so that still runs; stopImmediatePropagation
// only blocks listeners added after this one, which is every page script,
// since actor scripts run at DOMWindowCreated.
for (const type of ["keydown", "keypress", "keyup"]) {
  addEventListener(
    type,
    (e) => {
      if (!swallowKeys) return;
      if (passThrough(e)) return;
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
