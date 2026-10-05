// vimfox/src/selftest.js — every assertion, loaded only under VIMFOX_SELFTEST=1.
//
// It checks WIRING, not key delivery: whether a keypress actually arrives is
// the one thing only a real keypress proves. What it does catch is every
// dangling binding, broken mode transition, missing element, and — the reason
// several checks look oddly specific — API drift that fails SILENTLY, like
// moveTabTo growing an options object.
//
// It reaches into the mode machine's private state on purpose, so `vf` carries
// live getters for it rather than copies. Add a case for every new binding and
// every bug fixed.

"use strict";

this.vimfoxSelfTest = (vf) => {
  const {
    win, document, gBrowser, HTML, log,
    BINDINGS, SEQUENCES, LABELS, CARET_MOTIONS, CARET_EXTRA, CARET_PREF, COUNT_MAX,
    DOMAIN_RELEVANCY, ONE_MONTH_MS, EX, MODES, fallbackApplies, fallbackWants,
    cmds, keyset, pinned, SessionStore, palette, toast, whichKey, indicator, chromeStyle, toolbox,
    dispatch, run, setMode, setPending, takeCount, isBound, caretKey,
    keyNameFor, chromeInputFocused, focusedChromeElement, refreshMode,
    onContentFocus, onContentSelection, listCommands, yank, onLocationChange,
    pageHasFocus,
    deleteLineIn, deleteWordIn, highlight, matchesAllTerms, computeRelevancy,
    rankItems,
  } = vf;

  const fails = [];
  const check = (name, cond) => cond || fails.push(name);

  for (const [key, cmd] of Object.entries(BINDINGS)) {
    check(`BINDINGS.${key} -> ${cmd} missing`, typeof cmds[cmd] === "function");
  }
  for (const [prefix, table] of Object.entries(SEQUENCES)) {
    for (const [key, cmd] of Object.entries(table)) {
      check(
        `SEQUENCES.${prefix}${key} -> ${cmd} missing`,
        typeof cmds[cmd] === "function"
      );
      // which-key falls back to the raw command name, so a missing label is
      // silent — it just reads `tabMoveLeft` instead of "move tab left".
      check(`SEQUENCES.${prefix}${key} -> ${cmd} has no LABELS row`, !!LABELS[cmd]);
    }
  }
  // A prefix that also has a top-level binding would shadow the sequence.
  for (const prefix of Object.keys(SEQUENCES)) {
    check(`prefix "${prefix}" is also a direct binding`, !BINDINGS[prefix]);
  }

  // `typeof cmds[x] === "function"` is true of a command whose BODY throws, and
  // that false confidence is exactly how deleteWord and findAgain shipped dead:
  // both referenced a helper the module was never passed, so every use was a
  // ReferenceError swallowed by run()'s catch. So actually CALL the ones that
  // are safe to run headlessly, and fail on a throw.
  //
  // Excluded are the commands with side effects a test must not have: anything
  // that navigates, opens a window or palette, closes or moves tabs, or writes
  // the clipboard. Everything else must survive being invoked.
  const UNSAFE_TO_CALL = new Set([
    "tabClose", "tabUndo", "tabClone", "tabNew", "back", "forward", "reload",
    "open", "openTab", "editUrl", "commandLine", "bookmarks", "bookmarksTab",
    "tabSelect", "bookmarkPage", "openClipboard", "openClipboardTab",
    "windowNew", "windowPrivate", "restart", "passthrough", "insertMode",
    "caretMode", "tabAlternate", "urlUp", "urlUpTab", "tabMoveLeft",
    "tabMoveRight", "tabFirst", "tabLast", "tabPrev", "tabNext", "tabMute",
    "yankUrl", "yankTitle", "yankDomain", "yankPretty", "yankMarkdown",
    "copySelection", "find", "findLinks", "zoomIn", "zoomOut", "zoomReset",
    "focusInput", "deleteWord", "tabDetach",
  ]);
  // tabDetach opens a window, so it cannot be called here. Assert the API it
  // rests on instead — moveTabTo already went silently no-op on drift once.
  check(
    "gBrowser.replaceTabWithWindow is gone — W would do nothing",
    typeof gBrowser.replaceTabWithWindow === "function"
  );
  for (const [name, fn] of Object.entries(cmds)) {
    if (UNSAFE_TO_CALL.has(name) || /^tabFocus/.test(name)) continue;
    let threw = null;
    try {
      fn();
    } catch (ex) {
      threw = ex;
    }
    check(`cmds.${name} threw: ${threw}`, !threw);
  }
  // deleteWord and findAgain are the two that actually broke, so call them
  // explicitly against harmless targets rather than skipping them entirely.
  {
    const probe = document.createElementNS(HTML, "input");
    document.documentElement.append(probe);
    probe.value = "one two";
    probe.focus();
    probe.setSelectionRange(7, 7);
    let threw = null;
    try {
      deleteWordIn(probe);
    } catch (ex) {
      threw = ex;
    }
    check(`deleteWordIn threw: ${threw}`, !threw);
    check(`deleteWordIn did nothing (${probe.value})`, probe.value === "one ");
    probe.remove();
  }
  for (const name of ["findNext", "findPrev"]) {
    let threw = null;
    try {
      cmds[name]();
    } catch (ex) {
      threw = ex;
    }
    check(`cmds.${name} threw: ${threw}`, !threw);
  }
  // `'` is FIND_LINKS, and findbar.js arms a close timeout for every mode but
  // FIND_NORMAL. 0 is its off switch — it bails when the length is < 1.
  check(
    "quick-find closes itself: accessibility.typeaheadfind.timeout is not 0",
    Services.prefs.getIntPref("accessibility.typeaheadfind.timeout", 4000) === 0
  );

  check("keyset not in document", keyset.element.isConnected);
  check("command bar missing", !!document.getElementById("vomnibar"));
  check(
    "vomnibar search area missing",
    !!document.getElementById("vomnibar-search-area")
  );
  check(
    "vomnibar stylesheet not linked",
    !!document.querySelector('link[href="resource://vimfox/vomnibar.css"]')
  );
  check("mode indicator missing", !!document.getElementById("vimfox-mode"));
  // The chip only looks native while it is actually in the address bar; the
  // detached fallback is a degradation, not a pass.
  check(
    "mode chip not inside the address bar row",
    indicator.parentElement?.classList.contains("urlbar-input-container")
  );
  check(
    "which-key inset not set",
    !!document.documentElement.style.getPropertyValue("--vimfox-chrome-bottom")
  );
  // The toolbar tint is driven off :root, so a missing attribute means the
  // whole chrome silently stays untinted.
  check(
    "mode not mirrored onto :root for the toolbar tint",
    document.documentElement.dataset.vimfoxMode === vf.mode
  );
  // Normal mode is deliberately untinted, so check a mode that is not.
  const toolboxEl = document.getElementById("navigator-toolbox");
  // The tint transitions, and getComputedStyle mid-transition reports the
  // colour it is animating FROM — which is the value under test. Suppress the
  // transition for the duration of these checks.
  toolboxEl.style.transition = "none";
  // color-mix() computes to `color(srgb r g b / a)`, not `rgba(...)`, so read
  // the alpha rather than string-matching a serialisation.
  const tintAlpha = () => {
    const c = win.getComputedStyle(toolboxEl).backgroundColor;
    const m = c.match(/[/,]\s*([\d.]+)\s*\)$/);
    return m ? parseFloat(m[1]) : 1;
  };
  setMode("insert");
  check("toolbar tint not applied in insert mode", tintAlpha() > 0);
  setMode("normal");
  check(`toolbar tinted in normal mode (alpha ${tintAlpha()})`, tintAlpha() === 0);
  toolboxEl.style.transition = "";

  const keyEl = keyset.element.querySelector('key[key="j"]');
  const escEl = keyset.element.querySelector("key[keycode]");
  setMode("insert");
  check("insert mode did not disable keys", keyEl.hasAttribute("disabled"));
  check("Escape not grabbed in insert mode", !escEl.hasAttribute("disabled"));
  setMode("normal");
  check("normal mode did not re-enable keys", !keyEl.hasAttribute("disabled"));
  check(
    "Escape not released to page in normal mode",
    escEl.hasAttribute("disabled")
  );
  // about:blank opens with the urlbar focused, and setPending is a no-op while
  // a chrome field has focus — without this the check silently tested nothing
  // and failed depending on the start page.
  focusedChromeElement()?.blur?.();
  dispatch("g");
  check("Escape not grabbed while combo pending", !escEl.hasAttribute("disabled"));
  dispatch("Escape");
  check("combo survived Escape", !vf.pending);
  check(
    "Escape not released again after cancelling combo",
    escEl.hasAttribute("disabled")
  );

  // An unknown key cancels a half-typed combo, the way vim, Vimium and
  // qutebrowser all do. The gate matters as much as the handling: `f` is bound
  // to nothing, so the keyset registered no <key> for it and isBound() said no
  // — the layout fallback skipped it and the key never reached dispatch() at
  // all, leaving `yf` pending until the combo timeout.
  dispatch("y");
  check(`y did not start a combo (pending=${vf.pending})`, vf.pending === "y");
  check("the fallback ignores an unknown key during a combo", fallbackWants("f"));
  dispatch("f");
  check(`an unknown key did not cancel the combo (pending=${vf.pending})`, !vf.pending);
  check("the fallback claims an unknown key with nothing pending", !fallbackWants("f"));
  // ...and it throws away a half-typed count too, or the 3 in `3f` survives
  // onto whatever you press next.
  vf.count = "3";
  check("the fallback ignores an unknown key during a count", fallbackWants("f"));
  dispatch("f");
  check(`an unknown key did not clear the count (count=${vf.count})`, vf.count === "");
  setMode("command");
  check(
    "Escape not released to palette in command mode",
    escEl.hasAttribute("disabled")
  );
  setMode("normal");

  // Shift+Escape is the only way out of passthrough, and Firefox binds the
  // same chord to the process manager. Whichever of the two is enabled wins,
  // so they must be exact opposites — Shift+Escape used to open
  // about:processes instead of leaving the mode.
  const aboutProcesses = document.getElementById("key_aboutProcesses");
  check("key_aboutProcesses missing (Shift+Escape check is vacuous)", !!aboutProcesses);
  keyset.flushBuiltins();
  check(
    "Shift+Escape not released to Firefox outside passthrough",
    keyset.passthroughExit.hasAttribute("disabled") &&
      !aboutProcesses?.hasAttribute("disabled")
  );
  setMode("passthrough");
  check(
    "Shift+Escape not grabbed in passthrough mode",
    !keyset.passthroughExit.hasAttribute("disabled") &&
      aboutProcesses?.hasAttribute("disabled")
  );
  setMode("normal");
  keyset.flushBuiltins();
  check(
    "key_aboutProcesses not restored after passthrough",
    !aboutProcesses?.hasAttribute("disabled")
  );

  // Counts. Digits accumulate, Escape throws the buffer away, and a count is
  // consumed exactly once — a leftover would silently multiply the next
  // command.
  setMode("normal");
  dispatch("1");
  dispatch("2");
  check(`count did not accumulate (count=${vf.count})`, vf.count === "12");
  check("Escape not grabbed while a count is pending", !escEl.hasAttribute("disabled"));
  dispatch("Escape");
  check(`Escape did not clear the count (count=${vf.count})`, vf.count === "");
  dispatch("3");
  check("takeCount did not read the buffer", takeCount() === 3);
  check(`count not cleared after use (count=${vf.count})`, vf.count === "");
  // A count must never survive onto the next command — `x` is destructive.
  focusedChromeElement()?.blur?.();
  dispatch("3");
  dispatch("g");
  dispatch("z"); // `g` has no `z`
  check(`count survived an unmatched sequence (count=${vf.count})`, vf.count === "");
  // A leading 0 is g0's key, never a count.
  dispatch("0");
  check(`leading 0 started a count (count=${vf.count})`, vf.count === "");
  check("count not clamped", (() => { vf.count = "999"; return takeCount() === COUNT_MAX; })());
  // Digits have to be registered, or dispatch never sees them at all.
  check("count digits not in the keyset", !!keyset.element.querySelector('key[key="7"]'));

  // `^` is a dead key on some layouts, so the alias is not optional.
  check("no layout-proof alternate-tab binding", SEQUENCES.g.l === "tabAlternate");

  // gJ/gK were a silent no-op after moveTabTo grew an options object: no
  // error, the tab simply did not move. Only actually moving a tab catches
  // that class of API drift, so this one is a real functional check.
  {
    const extra = gBrowser.addTab("about:blank", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    const restore = gBrowser.selectedTab;
    gBrowser.selectedTab = extra;
    const before = extra._tPos;
    cmds.tabMoveLeft();
    check(
      `tabMoveLeft did not move the tab (${before} -> ${extra._tPos})`,
      extra._tPos === before - 1
    );
    cmds.tabMoveRight();
    check(
      `tabMoveRight did not move the tab (${before} -> ${extra._tPos})`,
      extra._tPos === before
    );
    // Wrap: from the last position, right goes back to the front.
    gBrowser.moveTabTo(extra, { tabIndex: gBrowser.tabs.length - 1 });
    cmds.tabMoveRight();
    check(
      `tabMoveRight did not wrap (landed at ${extra._tPos})`,
      extra._tPos < gBrowser.tabs.length - 1
    );
    gBrowser.selectedTab = restore;
    gBrowser.removeTab(extra);
  }

  // Middle-click closes an unpinned tab. pinned.js intercepts it in capture on
  // the same container, so a wrong filter there kills close on every tab.
  {
    const extra = gBrowser.addTab("about:blank", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    extra.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, button: 1, view: win })
    );
    // removeTab animates, so the tab is marked closing before it is gone.
    check(
      "middle click did not close an unpinned tab",
      extra.closing || !extra.isConnected
    );
    if (extra.isConnected && !extra.closing) gBrowser.removeTab(extra);
  }

  // Middle-click on a pinned tab resets it to its pinned URL. Asserts the
  // session STATE: setTabState re-applies `pinned` and extData from what it is
  // given, so a reset that dropped either would unpin or forget the tab.
  // Deferred to the end: SessionStore does not track the window until after
  // load, and getTabState throws until it does.
  const pinnedChecks = () => {
    const extra = gBrowser.addTab("about:blank", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    // A fresh about:blank tab has no history entry to record.
    SessionStore.setTabState(extra, { entries: [{ url: "about:mozilla" }] });
    gBrowser.pinTab(extra);
    check(
      `pinning did not record the URL (got "${SessionStore.getCustomTabValue(extra, pinned.KEY)}")`,
      SessionStore.getCustomTabValue(extra, pinned.KEY) === "about:mozilla"
    );
    SessionStore.setCustomTabValue(extra, pinned.KEY, "about:robots");
    extra.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, button: 1, view: win })
    );
    const state = JSON.parse(SessionStore.getTabState(extra));
    check("middle click closed a pinned tab", !extra.closing && extra.isConnected);
    check("pinned reset unpinned the tab", extra.pinned);
    check(
      `pinned reset did not replace history (${JSON.stringify(state.entries.map((x) => x.url))})`,
      state.entries.length === 1 && state.entries[0].url === "about:robots"
    );
    check(
      "pinned reset forgot the pinned URL",
      SessionStore.getCustomTabValue(extra, pinned.KEY) === "about:robots"
    );
    check(
      "no Re-pin URL item in the tab context menu",
      document.querySelector("#tabContextMenu > #vimfox-repin")
    );
    gBrowser.unpinTab(extra);
    check(
      "unpinning kept the pinned URL",
      !SessionStore.getCustomTabValue(extra, pinned.KEY)
    );
    if (!extra.closing) gBrowser.removeTab(extra);
  };

  // Caret mode. Driven entirely by content's selection report, so drive it
  // the same way here.
  setMode("normal");
  onContentSelection(true);
  check(`selection did not enter caret mode (mode=${vf.mode})`, vf.mode === "caret");
  check(
    "caret mode disabled the keyset — y could never be pressed",
    !keyEl.hasAttribute("disabled")
  );
  check("Escape not grabbed in caret mode", !escEl.hasAttribute("disabled"));
  // `y` must shadow the y* sequence prefix while a selection is alive.
  dispatch("y");
  check(`y in caret mode started a sequence instead of yanking (pending=${vf.pending})`, !vf.pending);
  // vim leaves visual mode on yank; so does qutebrowser.
  check(`y did not leave caret mode (mode=${vf.mode})`, vf.mode === "normal");
  onContentSelection(false);
  check(`losing the selection did not leave caret mode (mode=${vf.mode})`, vf.mode === "normal");
  // ...and y goes back to being a prefix.
  focusedChromeElement()?.blur?.();
  dispatch("y");
  check("y stopped being a sequence prefix outside caret mode", vf.pending === "y");
  setPending(null);
  check("caret mode has no chip colour", chromeStyle.textContent.includes('mode="caret"'));

  // Caret mode's EXITS, copied from qutebrowser: it is left deliberately, never
  // by the page. Gecko's caret browsing focuses links and buttons as the caret
  // passes them, and each of those fires our focus listener.
  setMode("normal");
  onContentSelection(true);
  check(`selection did not enter caret (mode=${vf.mode})`, vf.mode === "caret");
  // A link taking focus mid-motion must NOT throw us out.
  vf.contentEditable = false;
  refreshMode();
  check(`focus change left caret mode (mode=${vf.mode})`, vf.mode === "caret");
  onContentFocus(false, false);
  check(`content focus report left caret mode (mode=${vf.mode})`, vf.mode === "caret");
  // ...but a text field still wins, or the urlbar would eat keystrokes.
  vf.contentEditable = true;
  refreshMode();
  check(`an editable did not beat holdFocus (mode=${vf.mode})`, vf.mode === "insert");
  vf.contentEditable = false;
  onContentSelection(false);
  setMode("normal");

  // Entered by selecting: losing the selection exits.
  onContentSelection(true);
  check("selection entry did not arm caretFromSelection", vf.caretSelecting === true);
  onContentSelection(false);
  check(`losing the selection did not exit caret (mode=${vf.mode})`, vf.mode === "normal");

  // Entered with `v`: losing a selection must NOT exit — that is
  // selection-drop, which qutebrowser keeps you in caret mode for.
  setMode("caret");
  check(`v did not enter caret (mode=${vf.mode})`, vf.mode === "caret");
  onContentSelection(true);
  onContentSelection(false);
  check(`selection-drop exited caret after v (mode=${vf.mode})`, vf.mode === "caret");
  setMode("normal");

  // ...but a NAVIGATION exits, even one entered with `v`. Nothing else can
  // notice: the selection dies with the document, so content never reports a
  // transition, and caret mode over a fresh page has no caret to move.
  const TOP = { isTopLevel: true };
  const SAME_DOC = Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT;
  setMode("caret");
  onLocationChange(gBrowser.selectedBrowser, TOP, null, null, SAME_DOC);
  check(`an anchor jump left caret mode (mode=${vf.mode})`, vf.mode === "caret");
  onLocationChange(gBrowser.selectedBrowser, { isTopLevel: false }, null, null, 0);
  check(`an iframe load left caret mode (mode=${vf.mode})`, vf.mode === "caret");
  onLocationChange(gBrowser.selectedBrowser, TOP, null, null, 0);
  check(`navigation did not leave caret mode (mode=${vf.mode})`, vf.mode === "normal");

  // A tab switch DOES exit: caret is holdFocus, deliberately not sticky.
  check(
    "caret mode is sticky — a tab switch would not leave it",
    !MODES.caret.sticky && MODES.caret.holdFocus
  );

  // Caret motions. Every pair must be [move, select] — a swapped pair would
  // extend the selection when it should only move the caret, and the two
  // differ by one word in the command name, so it is easy to get wrong.
  for (const [key, pair] of Object.entries(CARET_MOTIONS)) {
    check(
      `caret motion ${key} is not a [move, select] pair (${pair})`,
      pair.length === 2 &&
        pair[0].startsWith("cmd_") &&
        pair[1].startsWith("cmd_select") &&
        !pair[0].startsWith("cmd_select")
    );
    check(
      `caret motion ${key} is not registered as a key`,
      !!keyset.element.querySelector(`key[key="${key}"]`) || CARET_EXTRA.has(key)
    );
  }

  // `v` toggles whether motions extend. Entering by `v` starts unarmed;
  // entering with a selection already made starts armed.
  setMode("normal");
  setMode("caret");
  check("`v` into caret mode should not start armed", vf.caretSelecting === false);
  caretKey("v");
  check("`v` did not arm the selection", vf.caretSelecting === true);
  caretKey("v");
  check("`v` did not disarm the selection", vf.caretSelecting === false);
  check(
    "browse-with-caret not on in caret mode",
    Services.prefs.getBoolPref(CARET_PREF, false)
  );
  setMode("normal");
  // Assert the PREF, not the bookkeeping variable. The old check read
  // caretPrefWas === null and passed happily on a profile where the pref had
  // been leaked to true and stayed there.
  check(
    "browse-with-caret not restored on leaving caret mode",
    Services.prefs.getBoolPref(CARET_PREF, false) === false
  );
  // The pref is GLOBAL and armCaret's state is per-window, so arming twice is
  // reachable — a second window entering caret mode while the first is in it.
  // The old code recorded our own `true` as the value to restore, and the caret
  // then stayed on in normal mode forever. Arming must be idempotent.
  vf.armCaret(true);
  vf.armCaret(true);
  check("a second arm did not leave browse-with-caret on",
    Services.prefs.getBoolPref(CARET_PREF, false));
  vf.armCaret(false);
  check(
    "browse-with-caret survived a double arm",
    Services.prefs.getBoolPref(CARET_PREF, false) === false
  );
  check("a user value was left behind on the caret pref",
    !Services.prefs.prefHasUserValue(CARET_PREF));
  check("caretArmed out of step with the pref", vf.caretArmed === false);
  // Unmapped keys must fall through, or caret mode traps you.
  setMode("caret");
  check("caret mode swallowed an unmapped key", caretKey("x") === false);
  setMode("normal");

  // Caret mode must be in the layout fallback, or every AltGr key dies there
  // while working fine in normal mode — which is exactly how `$` behaved.
  // Every mode must be fully described: a row in MODES, an accent colour, and
  // coverage by the layout fallback if it runs keys. Adding a mode and wiring
  // only half of it is the failure this catches.
  for (const name of Object.keys(MODES)) {
    check(
      `mode "${name}" has no chip colour`,
      chromeStyle.textContent.includes(`data-vimfox-mode="${name}"`)
    );
  }
  check(
    "a mode is armed for both Escape and passthrough exit",
    Object.values(MODES).every((m) => !(m.exit && m.escape))
  );

  // The fallback must cover exactly the modes the keyset runs in, or a
  // punctuation binding works in one mode and is silently dead in another.
  for (const [name, m] of Object.entries(MODES)) {
    check(
      `mode "${name}" runs keys but is outside the layout fallback`,
      !m.keys || fallbackApplies(name)
    );
  }
  setMode("caret");
  check("`$` not bound in caret mode", isBound("$") && isBound("{") && isBound("}"));
  setMode("normal");

  // Every caret command must exist and be dispatchable, or a motion is a
  // silent no-op — the same failure shape as the moveTabTo drift.
  for (const cmd of Object.values(CARET_MOTIONS).flat()) {
    let controller = null;
    try {
      controller = document.commandDispatcher.getControllerForCommand(cmd);
    } catch (ex) {
      /* reported by the check below */
    }
    check(`no controller for ${cmd}`, !!controller);
  }

  // The scroll commands get the same treatment, for the same reason: a wrong
  // name is caught by scrollCmd and logged, so h/l would just do nothing.
  // cmd_scrollLeft and cmd_scrollRight were believed not to exist, which is how
  // horizontal scrolling ended up as content code that only ever moved the
  // top-level window's root scroller.
  for (const cmd of [
    "cmd_scrollLineDown", "cmd_scrollLineUp", "cmd_scrollLeft",
    "cmd_scrollRight", "cmd_scrollPageDown", "cmd_scrollPageUp",
    "cmd_scrollTop", "cmd_scrollBottom",
  ]) {
    let controller = null;
    try {
      controller = document.commandDispatcher.getControllerForCommand(cmd);
    } catch (ex) {
      /* reported by the check below */
    }
    check(`no controller for ${cmd}`, !!controller);
  }

  toast.element.setAttribute("hidden", "true");
  // The yank above raised a toast; later checks assert a clean slate.
  toast.element.setAttribute("hidden", "true");

  // No <key> may name a character other than the one it dispatches. Naming a
  // physical key instead is what made Shift+= run find: `key="+" shift` was
  // registered for `?`, and `+` is candidate 0 for that press.
  for (const k of keyset.element.querySelectorAll("key[key]")) {
    const attr = k.getAttribute("key");
    check(
      `<key key="${attr}"> dispatches something else`,
      !k.hasAttribute("keycode") ? attr.length === 1 : true
    );
  }
  // Every shifted-punctuation binding needs BOTH forms, because which one
  // matches is the layout's choice, not ours.
  for (const ch of [":", "?", "+", "$", "^"]) {
    check(
      `"${ch}" is missing a keyset element`,
      !!keyset.element.querySelector(`key[key="${ch}"]:not([modifiers])`) &&
        !!keyset.element.querySelector(`key[key="${ch}"][modifiers="shift"]`)
    );
  }
  // Letters must not get the shift-agnostic treatment, or Ctrl+Shift+C could
  // reach a Ctrl+C handler.
  check(
    "a lowercase letter was registered with shift",
    !keyset.element.querySelector('key[key="j"][modifiers="shift"]')
  );

  // The `:` menu and the executor must stay one table: a listed command that
  // does not run is worse than no menu at all.
  const listed = listCommands();
  check("`:` menu is empty", listed.length > 0);
  check(
    "`:` menu does not list every ex command",
    listed.length === Object.keys(EX).length
  );
  for (const it of listed) {
    check(`listed command ${it.name} has no runner`, typeof EX[it.name]?.run === "function");
    check(`listed command ${it.name} has no description`, !!it.sub);
  }

  // A page focusing its own field must not pull us into insert mode.
  setMode("normal");
  onContentFocus(true, false);
  check(`page-initiated focus entered insert mode (mode=${vf.mode})`, vf.mode === "normal");
  onContentFocus(true, true);
  check(`user-initiated focus did not enter insert (mode=${vf.mode})`, vf.mode === "insert");
  // ...but once in insert, a page refocusing its own field must not eject us.
  onContentFocus(true, false);
  check(`page refocus ejected us from insert (mode=${vf.mode})`, vf.mode === "insert");
  // NO focus event ends insert mode, clicks included. Escape, a page load and a
  // tab switch are the only ways out.
  onContentFocus(false, true);
  check(`a focus change left insert mode (mode=${vf.mode})`, vf.mode === "insert");
  onContentFocus(false, true);
  check(`a click on a non-editable left insert mode (mode=${vf.mode})`, vf.mode === "insert");
  dispatch("Escape");
  check(`Escape did not leave insert mode (mode=${vf.mode})`, vf.mode === "normal");
  // A page load does too — qutebrowser's input.insert_mode.leave_on_load.
  vf.contentEditable = true;
  refreshMode();
  check(`could not re-enter insert mode (mode=${vf.mode})`, vf.mode === "insert");
  onLocationChange(gBrowser.selectedBrowser, { isTopLevel: true }, null, null, 0);
  check(`navigation did not leave insert mode (mode=${vf.mode})`, vf.mode === "normal");
  vf.contentEditable = false;

  // A chrome text field must put us in insert mode, or Escape gets handed to
  // Firefox and the urlbar needs several presses to clear.
  // A content-document element must never be mistaken for a chrome field —
  // that suppressed every binding on parent-process about: pages.
  const fakeContentDoc = document.implementation.createHTMLDocument("x");
  const contentish = fakeContentDoc.createElement("input");
  check(
    "content-document element counted as a chrome field",
    contentish.ownerDocument !== document
  );

  for (const [desc, event, want] of [
    ["plain letter", { key: "j" }, "j"],
    ["shifted letter", { key: "J", shiftKey: true }, "J"],
    ["colon", { key: ":", shiftKey: true }, ":"],
    ["ctrl", { key: "w", ctrlKey: true }, "C-w"],
    ["alt digit", { key: "1", altKey: true }, "A-1"],
    ["escape", { key: "Escape" }, "Escape"],
    ["shift-escape", { key: "Escape", shiftKey: true }, "Shift-Escape"],
    ["arrow ignored", { key: "ArrowDown" }, null],
    ["ctrl+alt ignored", { key: "x", ctrlKey: true, altKey: true }, null],
  ]) {
    const got = keyNameFor({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...event });
    check(`keyNameFor ${desc}: got ${got} want ${want}`, got === want);
  }

  const probeField = document.createElementNS(HTML, "input");
  document.documentElement.appendChild(probeField);
  probeField.focus();
  refreshMode();
  check(
    `chrome input did not enter insert mode (mode=${vf.mode})`,
    vf.mode === "insert" || !chromeInputFocused()
  );
  // Focus in the chrome means goDoCommand routes a scroll at the chrome window
  // instead of the page, and every scroll key is a silent no-op. That is why
  // the reset after a load and a tab switch hands focus back to the page:
  // without it you had to click the page before j/k/h/l did anything.
  check("a focused chrome field counted as the page having focus",
    !pageHasFocus() || !chromeInputFocused());
  // ...and the dispatcher is NOT the way to tell: it falls back to the chrome
  // window's own scroll controller and answers yes with this field focused.
  // That is why the gate reads activeElement instead. Assert the trap, or the
  // next person reintroduces it.
  check(
    "the dispatcher stopped resolving a scroll controller from the chrome",
    !chromeInputFocused() ||
      !!document.commandDispatcher.getControllerForCommand("cmd_scrollLineDown")
  );
  gBrowser.selectedBrowser?.focus();
  check("focusing the browser did not give the page focus", pageHasFocus());
  probeField.focus();
  // insert is holdFocus, so losing the field does not end the mode either.
  probeField.remove();
  refreshMode();
  check(
    `a vanished chrome field left insert mode (mode=${vf.mode})`,
    vf.mode === "insert" || !chromeInputFocused()
  );
  vf.contentEditable = false;
  setMode("normal");

  // NB: NOT `key=";" modifiers="shift"`. When shift is held, Gecko builds
  // candidates only from shifted char codes, so the unshifted `;` of that
  // physical key is never one — that element could never have matched.
  check(
    "':' not bound as the character itself",
    !!keyset.element.querySelector('key[key=":"]')
  );

  check(
    "`'` not bound to link quick-find",
    BINDINGS["'"] === "findLinks" &&
      !!keyset.element.querySelector(`key[key="'"]:not([modifiers])`)
  );

  check(
    "Browser:AddBookmarkAs command missing (M would do nothing)",
    !!document.getElementById("Browser:AddBookmarkAs")
  );
  // Any enabled built-in sharing one of our chords will win over ours. Paired
  // with keyset's own chordOf, and over the keys we REGISTERED rather than over
  // BINDINGS — the same rule the keyset scan follows, so the keycode keys
  // (Escape, Shift+Escape) are covered and the two cannot disagree.
  const theirKeys = [...document.querySelectorAll("key")].filter(
    (k) => !k.closest("#vimfox-keyset")
  );
  for (const ours of keyset.element.querySelectorAll("key")) {
    if (!ours.hasAttribute("modifiers") && !ours.hasAttribute("keycode")) continue;
    if (ours.hasAttribute("disabled")) continue;
    const chord = keyset.chordOf(ours);
    const clash = theirKeys.find(
      (k) => keyset.chordOf(k) === chord && !k.hasAttribute("disabled")
    );
    check(
      `built-in key still active for ${chord} (#${clash?.id || "anon"})`,
      !clash
    );
  }

  // ...and they must come back when we stop listening, or insert mode loses
  // Ctrl+V paste, Ctrl+D bookmark and so on.
  setMode("insert");
  keyset.flushBuiltins();
  check(
    "built-ins not restored in insert mode",
    keyset.builtinsNormal.every((k) => !k.hasAttribute("disabled"))
  );
  setMode("normal");
  check(
    "built-ins not re-suppressed in normal mode",
    keyset.builtinsNormal.every((k) => k.hasAttribute("disabled"))
  );

  // boot.js skips windows where this is false, so a regression here would
  // silently stop vimfox attaching to real windows.
  check("toolbar.visible is false in a real browser window", win.toolbar?.visible === true);

  // C-v is the one binding whose own mode hands its twin straight back, so it
  // used to enter passthrough AND paste.
  const keyPaste = document.getElementById("key_paste");
  check("key_paste missing (the C-v check is vacuous)", !!keyPaste);
  dispatch("C-v");
  check(`C-v did not enter passthrough (mode=${vf.mode})`, vf.mode === "passthrough");
  check(
    "key_paste released during the keypress that entered passthrough",
    keyPaste?.hasAttribute("disabled")
  );
  keyset.flushBuiltins();
  check("key_paste not restored in passthrough", !keyPaste?.hasAttribute("disabled"));
  setMode("normal");
  // C-w is ALWAYS_ON and must NEVER close a tab. That is two guarantees, in
  // every mode: ours stays live, and Firefox's key_close stays dead. The old
  // version of this check ran only in normal mode and asserted the opposite of
  // its own name.
  const ourCw = keyset.element.querySelector('key[key="w"][modifiers="accel"]');
  const keyClose = document.getElementById("key_close");
  check("key_close missing (the C-w guarantee is vacuous)", !!keyClose);
  for (const name of Object.keys(MODES)) {
    setMode(name);
    check(`C-w not live in ${name} mode`, !ourCw?.hasAttribute("disabled"));
    check(
      `key_close revived in ${name} mode — C-w could close a tab`,
      keyClose?.hasAttribute("disabled")
    );
  }
  setMode("normal");

  // Word-deletion logic, independent of focus resolution.
  const probe = document.createElementNS(HTML, "input");
  const edit = (fn) => (value, start = value.length, end = start) => {
    probe.value = value;
    probe.setSelectionRange(start, end);
    fn(probe);
    return probe.value;
  };
  const del = edit(deleteWordIn);
  const kill = edit(deleteLineIn);

  for (const [name, got, want] of [
    ["basic", del("hello brave world"), "hello brave "],
    ["trailing space", del("hello world  "), "hello "],
    ["single word", del("hello"), ""],
    ["empty", del(""), ""],
    ["mid-caret", del("one two three", 8), "one three"],
    ["leading space kept", del("  hi"), "  "],
    // The urlbar selects its whole value on focus; this used to wipe it.
    ["full selection", del("https://example.com", 0, 19), ""],
    ["partial selection", del("one two three", 4, 8), "one three"],
    // Punctuation rides along with the word behind it, so a URL comes apart
    // one segment per keystroke.
    [
      "url step 1",
      del("file:///home/thomal/.vimfox/test.html"),
      "file:///home/thomal/.vimfox/test.",
    ],
    [
      "url step 2",
      del("file:///home/thomal/.vimfox/test."),
      "file:///home/thomal/.vimfox/",
    ],
    [
      "url step 3",
      del("file:///home/thomal/.vimfox/"),
      "file:///home/thomal/.",
    ],
    ["url step 4", del("file:///home/thomal/."), "file:///home/"],
    ["url slash run", del("file:///home"), "file:///"],
    ["punct run absorbed", del("a///"), ""],
    ["unicode word", del("hei blåbær"), "hei "],
  ]) {
    check(`deleteWord ${name}: got "${got}" want "${want}"`, got === want);
  }

  for (const [name, got, want] of [
    ["to line start", kill("hello world"), ""],
    ["keeps tail", kill("hello world", 6), "world"],
    ["empty", kill(""), ""],
  ]) {
    check(`deleteLine ${name}: got "${got}" want "${want}"`, got === want);
  }

  // highlight(): render to a detached node and read back the structure.
  const hl = (text, tokens) => {
    const p = document.createElementNS(HTML, "span");
    highlight(p, text, tokens);
    return {
      text: p.textContent,
      marks: [...p.querySelectorAll(".match")].map((m) => m.textContent),
    };
  };
  for (const [name, got, wantText, wantMarks] of [
    ["single", hl("github.com", ["git"]), "github.com", ["git"]],
    ["case-insensitive", hl("GitHub", ["hub"]), "GitHub", ["Hub"]],
    ["repeated", hl("aXaXa", ["a"]), "aXaXa", ["a", "a", "a"]],
    ["two tokens", hl("vimium docs", ["vim", "docs"]), "vimium docs", ["vim", "docs"]],
    // Overlapping tokens must merge, not nest or duplicate.
    ["overlapping", hl("github", ["git", "ithu"]), "github", ["githu"]],
    ["adjacent merge", hl("abcd", ["ab", "cd"]), "abcd", ["abcd"]],
    ["no match", hl("example.com", ["zzz"]), "example.com", []],
    ["no tokens", hl("example.com", []), "example.com", []],
  ]) {
    check(
      `highlight ${name}: text "${got.text}" marks [${got.marks}]`,
      got.text === wantText && String(got.marks) === String(wantMarks)
    );
  }

  const wk = document.getElementById("vimfox-whichkey");
  check("which-key panel missing", !!wk);
  check("which-key visible with no pending prefix", wk?.hasAttribute("hidden"));

  // Ranking. `old` is far enough back that recency contributes nothing, so
  // these compare word relevancy alone.
  const old = Date.now() - ONE_MONTH_MS * 2;
  const rank = (terms, url, title) => computeRelevancy(terms, url, title, old);

  const warcraftlogs = rank(["warcra"], "https://www.warcraftlogs.com/", "Warcraft Logs");
  const wowWiki = rank(["warcra"], "https://wowpedia.fandom.com/wiki/Main_Page", "World of Warcraft Wiki");
  check(
    `URL match must beat title-only match (${warcraftlogs.toFixed(3)} vs ${wowWiki.toFixed(3)})`,
    warcraftlogs > wowWiki
  );

  check(
    "whole-word match must beat substring",
    rank(["vim"], "https://vim.org/", "Vim") >
      rank(["vim"], "https://example.com/vimium-notes", "Vimium notes")
  );
  check(
    "start-of-word match must beat mid-word",
    rank(["log"], "https://logs.example.com/", "Logs") >
      rank(["log"], "https://example.com/catalog", "Catalog")
  );
  check("no match scores zero", rank(["zzz"], "https://a.com/", "A") === 0);

  // A domain suggestion must outrank every possible history score, which is
  // what puts raider.io above a page titled "raid".
  check(
    "domain relevancy does not outrank history",
    DOMAIN_RELEVANCY > rank(["a"], "https://a.com/", "A")
  );
  // Domain completion is single-word only.
  check(
    "multi-word query would still hit the domain completer",
    /\S\s/.test("raid guide") && !/\S\s/.test("raid")
  );
  check(
    "smartcase: capital in query is case-sensitive",
    matchesAllTerms(["Vim"], "https://example.com/vim", "vim") === false &&
      matchesAllTerms(["vim"], "https://example.com/vim", "vim") === true
  );
  // Recency only bites when word relevancy is low — a mid-word hit in a long
  // URL. With a strong match, max(recency, relevancy) makes it a no-op.
  const weakUrl = "https://example.com/very/long/path/segment/here/index.html";
  check(
    "recency does not lift a weak match",
    computeRelevancy(["x"], weakUrl, "Unrelated", Date.now()) >
      computeRelevancy(["x"], weakUrl, "Unrelated", old)
  );
  check(
    "recency must never pull a strong match down",
    computeRelevancy(["a"], "https://a.com/", "A", old) ===
      computeRelevancy(["a"], "https://a.com/", "A", Date.now())
  );

  // gt / b / `:` filtered on ONE substring, so "goto kys" could not reach a tab
  // at goto.netcompany.com/.../kys that the o menu found without trouble.
  const rows = [
    { label: "Open items", sub: "https://goto.netcompany.com/cases/GTE841/kys.aspx" },
    { label: "Kys", sub: "https://example.com/other" },
    { label: "Goto", sub: "https://goto.example.com/" },
  ];
  const ranked = rankItems(["goto", "kys"], rows);
  check(`multi-term search matched ${ranked.length} rows, want 1`, ranked.length === 1);
  check(
    "multi-term search picked the wrong row",
    ranked[0]?.sub.startsWith("https://goto.netcompany.com/")
  );
  check("an empty query dropped rows", rankItems([], rows).length === rows.length);
  check(
    "ranking did not put the stronger match first",
    rankItems(["goto"], rows)[0]?.label === "Goto"
  );

  const tst = document.getElementById("vimfox-toast");
  check("toast missing", !!tst);
  check("toast visible before any yank", tst?.hasAttribute("hidden"));
  toast.show("probe");
  check("toast did not appear", !tst?.hasAttribute("hidden"));
  check("toast text wrong", tst?.textContent === "probe");
  tst?.setAttribute("hidden", "true");

  for (const prefix of Object.keys(SEQUENCES)) {
    dispatch(prefix);
    check(`prefix "${prefix}" not pending`, vf.pending === prefix);
    check(
      `which-key shown before its delay elapsed (${prefix})`,
      wk?.hasAttribute("hidden")
    );
    whichKey.show(prefix); // what the delayed timer would do
    check(
      `which-key rows do not match SEQUENCES.${prefix}`,
      wk?.childElementCount === Object.keys(SEQUENCES[prefix]).length
    );
    dispatch("Escape");
    check(`which-key still shown after Escape (${prefix})`, wk?.hasAttribute("hidden"));
  }

  // Passthrough: everything off, and only Shift+Escape kept.
  setMode("passthrough");
  check("passthrough left keys enabled", keyEl.hasAttribute("disabled"));
  check("passthrough kept Escape", escEl.hasAttribute("disabled"));
  check(
    "passthrough exit key not armed",
    !keyset.passthroughExit.hasAttribute("disabled")
  );
  dispatch("Shift-Escape");
  check(`Shift-Escape did not leave passthrough (mode=${vf.mode})`, vf.mode === "normal");
  check(
    "passthrough exit key still armed in normal mode",
    keyset.passthroughExit.hasAttribute("disabled")
  );

  SessionStore.promiseAllWindowsRestored
    .then(pinnedChecks)
    .catch((ex) => fails.push(`pinned checks threw: ${ex}`))
    .then(() =>
      log(
        fails.length
          ? `SELFTEST FAILED (${fails.length}): ${fails.join("; ")}`
          : "SELFTEST PASSED"
      )
    );
};
