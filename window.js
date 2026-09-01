// vimfox/window.js — loaded into each browser.xhtml window (parent process).
//
// The parent process owns the mode. Normal-mode keys are registered as XUL
// <key reserved="true">, which Firefox matches in the parent BEFORE consulting
// the content process — the same path Ctrl+W takes, which is why Ctrl+W closes
// a hung tab. That is the whole point: keys work during page load and while the
// content process is busy, because the content process is not involved.
//
// Entering insert mode disables the keyset so typing reaches the page.

"use strict";

(() => {
  const win = this;
  const { document, gBrowser } = win;

  // `Services` is a chrome global in modern Firefox; the ESM was removed.
  const { PlacesUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PlacesUtils.sys.mjs"
  );
  const { SessionStore } = ChromeUtils.importESModule(
    "resource:///modules/sessionstore/SessionStore.sys.mjs"
  );

  const HTML = "http://www.w3.org/1999/xhtml";
  // cmd_scrollLineDown moves one line; 3 per keypress feels like Vimium's 60px.
  // The horizontal pair scrolls the same unit, so h/l share the constant.
  const SCROLL_LINES = 3;

  // Alt-1..8 focus that tab, Alt-9 the last one — qutebrowser's convention.
  const TAB_DIGITS = 9;

  // How long a half-typed combo (and its which-key panel) stays pending.
  const COMBO_TIMEOUT = 10000;

  // Grace period before which-key appears. Finish the combo faster than this
  // and the panel never shows at all.
  const WHICHKEY_DELAY = 500;

  // How long the yank confirmation stays up.
  const TOAST_MS = 1000;

  // Ceiling on a vim-style count, so a slipped keystroke cannot run a command
  // hundreds of times.
  const COUNT_MAX = 100;

  const log = (m) => dump(`vimfox: ${m}\n`);

  // ---------------------------------------------------------------- actor ---

  function send(name, data) {
    try {
      gBrowser.selectedBrowser.messageManager?.sendAsyncMessage(name, data ?? {});
    } catch (ex) {
      // Tab is mid-navigation or crashed. Not an error.
    }
  }

  // Firefox's own scroll commands. The command dispatcher forwards these to the
  // focused remote browser, so scrolling needs no code of ours in the content
  // process — which is what kept breaking. It also means j/k work on any
  // document the built-in commands work on, about: pages included.
  // The focused chrome text field (palette, urlbar), or null.
  function chromeField() {
    const el = focusedChromeElement();
    return el && (el.localName === "input" || el.localName === "textarea")
      ? el
      : null;
  }

  // The findbar containing focus (quick-find via ' or /, or Ctrl+F), or null.
  function focusedFindbar() {
    const el = Services.focus.focusedElement ?? document.activeElement;
    return el?.closest?.("findbar") ?? null;
  }

  function applyEdit(el, head) {
    el.value = head + el.value.slice(el.selectionEnd);
    el.setSelectionRange(head.length, head.length);
    // The palette filters on `input`, so it has to be told.
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
  }

  // Delete the word before the caret. Kept separate from focus resolution so
  // the string handling is testable on its own.
  const isSpace = (c) => /\s/.test(c);
  const isWordChar = (c) => /[\p{L}\p{N}_]/u.test(c);

  function deleteWordIn(el) {
    const { selectionStart: s, selectionEnd: e, value } = el;

    // With a selection, delete only that. The urlbar selects the whole URL on
    // focus, so treating it as "caret at 0" wiped the entire line.
    if (s !== e) {
      applyEdit(el, value.slice(0, s));
      return;
    }

    // Skip whitespace, absorb any trailing punctuation, then take the word
    // behind it. Punctuation riding along with the word (rather than costing
    // its own keystroke) is what walks a URL a segment at a time.
    let i = s;
    while (i > 0 && isSpace(value[i - 1])) i--;
    while (i > 0 && !isSpace(value[i - 1]) && !isWordChar(value[i - 1])) i--;
    while (i > 0 && isWordChar(value[i - 1])) i--;
    applyEdit(el, value.slice(0, i));
  }

  // Ctrl+U: delete from the start of the line to the caret.
  function deleteLineIn(el) {
    const { selectionStart: s, value } = el;
    const lineStart = value.lastIndexOf("\n", Math.max(s - 1, 0)) + 1;
    applyEdit(el, value.slice(0, lineStart));
  }


  // ---------------------------------------------------------------- mode ---

  // The mode machine, as a table rather than as conditions scattered across the
  // file. Every "does X happen in this mode" question is answered from here, so
  // adding a mode is one row instead of a hunt for `mode === "..."`.
  //
  //   keys     our XUL keyset is live — and so is the layout fallback, which
  //            must cover exactly the modes the keyset does or punctuation
  //            bindings die in one mode while working in another
  //   escape   we own Escape unconditionally (a pending combo or a half-typed
  //            count also claims it, whatever the mode)
  //   swallow  content kills every key it is not explicitly handed
  //   sticky   focus changes and tab switches must NOT move us out; the mode is
  //            left deliberately or not at all
  //   exit     Shift-Escape is armed as the way out
  const MODES = {
    normal:      { keys: true,  escape: false, swallow: true },
    // holdFocus: the page moving focus does not leave this mode. Gecko's caret
    // browsing focuses links and buttons as the caret passes over them, and
    // every one of those used to throw you straight back to normal mid-motion.
    // qutebrowser leaves caret mode only on c / Escape / yank, and so do we —
    // plus a tab switch, which `sticky` (below) deliberately does NOT cover.
    caret:       { keys: true,  escape: true,  swallow: true, holdFocus: true },
    // insert is holdFocus for the same reason from the other side: kagi's j/k
    // walk the search results by FOCUSING each link, and a focus-driven exit
    // ended insert mode on the first keystroke — after which the second was
    // swallowed. qutebrowser never leaves insert on focus at all; its
    // auto_leave hangs off mousePress, so a click, Escape, or a page load
    // (leave_on_load) are the only ways out. Ours are the same three, plus a
    // tab switch.
    insert:      { keys: false, escape: true,  swallow: false, holdFocus: true },
    command:     { keys: false, escape: false, swallow: false, sticky: true },
    passthrough: { keys: false, escape: false, swallow: false, sticky: true, exit: true },
  };

  let mode = "normal";
  const now = () => MODES[mode];
  let pending = null; // active sequence prefix, e.g. "g"
  let count = ""; // digits typed before a command, vim-style: 3j
  let lastTab = null; // the tab `^` goes back to
  let contentSelected = false; // page has a non-empty selection
  let caretSelecting = false; // caret motions extend the selection (`v`)
  let caretFromSelection = false; // entered caret by selecting, not by `v`
  let pendingTimer = 0;
  let whichKeyTimer = 0;

  // Escape is ours only when there is something to cancel: leaving insert
  // mode, or aborting a half-typed key combo. With neither pending it stays
  // disabled, so the page receives Escape as normal.
  function updateEscape() {
    keyset.setEscapeEnabled(now().escape || !!pending || !!count);
    keyset.setPassthroughExitEnabled(!!now().exit);
  }

  // Single writer for the pending-prefix state, so the which-key panel and
  // Escape routing can never drift out of sync with it.
  // `quiet` suppresses which-key. Caret mode reuses `g` as a prefix but only
  // implements gg, so the normal-mode g menu would advertise a dozen commands
  // that do nothing there.
  function setPending(prefix, { quiet = false } = {}) {
    pending = prefix;
    win.clearTimeout(pendingTimer);
    win.clearTimeout(whichKeyTimer);
    whichKey.hide();
    if (prefix) {
      pendingTimer = win.setTimeout(() => setPending(null), COMBO_TIMEOUT);
      if (!quiet) {
        whichKeyTimer = win.setTimeout(() => whichKey.show(prefix), WHICHKEY_DELAY);
      }
    }
    updateEscape();
  }

  const CARET_PREF = "accessibility.browsewithcaret";
  // Whether WE turned browse-with-caret on. Not the pref's previous value: the
  // pref is GLOBAL and this state is per-window, so remembering one leaked. Two
  // windows both entering caret mode meant the second recorded our own `true`
  // as "the user's setting" and restored it on the way out — after which the
  // caret was on in normal mode, forever, and every later arm re-recorded it.
  let caretArmed = false;

  function armCaret(on) {
    try {
      if (on === caretArmed) return;
      caretArmed = on;
      if (on) {
        Services.prefs.setBoolPref(CARET_PREF, true);
        // Entering via a mouse selection arrives with one already made; via `v`
        // it does not, and motions should then just move the caret.
        caretSelecting = contentSelected;
        caretFromSelection = contentSelected;
      } else {
        // clearUserPref, not setBoolPref(false): it puts the pref back to
        // whatever the profile says instead of to a value we guessed, and it is
        // idempotent, so an unbalanced disarm cannot write anything wrong.
        Services.prefs.clearUserPref(CARET_PREF);
        caretSelecting = false;
        caretFromSelection = false;
      }
    } catch (ex) {
      log(`caret pref failed: ${ex}`);
    }
  }

  function setMode(next) {
    if (mode === next) return;
    // The Gecko motion commands need a caret to move, so caret mode turns
    // browse-with-caret on and puts it back exactly as it was on the way out.
    if (next === "caret") armCaret(true);
    else if (mode === "caret") armCaret(false);
    mode = next;
    count = "";
    setPending(null);
    // Caret mode keeps the normal-mode keyset: it is normal mode with a
    // selection alive, not a separate keymap.
    keyset.setEnabled(now().keys);
    updateEscape();
    broadcastMode();
    log(`mode -> ${mode}`);
    ui.paintMode(mode);
  }

  // Content needs the mode so it can swallow every key in normal mode. All
  // frames in the window, not just the selected tab — background tabs get no
  // keys anyway, and this avoids a stale frame waking up unswallowed.
  function broadcastMode() {
    try {
      // `swallow` travels with the mode so the table stays the single source
      // of truth — content must not keep its own copy of which modes swallow.
      win.messageManager.broadcastAsyncMessage("VimFox:Mode", {
        mode,
        swallow: !!now().swallow,
      });
    } catch (ex) {
      log(`mode broadcast failed: ${ex}`);
    }
  }

  // Last editable state reported by the frame script, so chrome focus changes
  // can be reconciled against it without another IPC round trip.
  let contentEditable = false;

  function onContentFocus(editable, userInitiated, clicked) {
    if (!editable) {
      contentEditable = false;
      // insert is holdFocus, so the refreshMode below keeps us in it when the
      // PAGE moved focus. A real click on a non-editable element is the one
      // focus event that gets you out — qutebrowser's auto_leave.
      if (mode === "insert" && clicked) return setMode("normal");
    } else if (userInitiated || mode === "insert") {
      // Already in insert: a page refocusing one of its own fields mid-typing
      // must not knock us out, so accept it.
      contentEditable = true;
    } else {
      return; // page grabbed focus by itself — ignore it entirely
    }
    refreshMode();
  }

  // Insert mode means "a text field has focus" — content OR browser UI. The
  // urlbar counts: without this it stayed in normal mode, where Escape is
  // handed to Firefox, whose own urlbar Escape chain needs several presses.
  function refreshMode() {
    // The palette owns the keyboard; passthrough is only left deliberately.
    if (now().sticky) return;
    const editing = chromeInputFocused() || contentEditable;
    // A text field always wins, even over holdFocus: the urlbar with our keyset
    // still live would eat the keystrokes instead of typing them.
    if (editing) return setMode("insert");
    if (now().holdFocus) return;
    setMode("normal");
  }

  // Content reports only the has/has-not transition; the text itself never
  // crosses the process boundary — cmd_copy runs where the selection lives.
  function onContentSelection(has) {
    contentSelected = has;
    if (has && mode === "normal") return setMode("caret");
    // Losing the selection only leaves caret mode if the selection is what put
    // us there. Entering deliberately with `v` is qutebrowser's caret mode:
    // dropping the selection keeps the caret, it does not exit.
    if (!has && mode === "caret" && caretFromSelection) setMode("normal");
  }

  // Only elements of the chrome document count. Pages like about:sessionrestore
  // run in the PARENT process, so focusedElement can be an element of their
  // content document — which used to look like a chrome text field and made
  // run() suppress every binding on those pages.
  function focusedChromeElement() {
    const el = Services.focus.focusedElement ?? document.activeElement;
    return el && el.ownerDocument === document ? el : null;
  }

  function chromeInputFocused() {
    const el = focusedChromeElement();
    if (!el) return false;
    const tag = el.localName;
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  function run(name) {
    // Belt and braces: never fire a normal-mode command into a chrome text
    // field (urlbar, findbar, search box). The actor tells us about content
    // fields; this covers the browser UI, with no IPC involved.
    if (chromeInputFocused() && !CHROME_INPUT_OK.has(name)) {
      const el = focusedChromeElement();
      // Drop the count too: it would otherwise apply to whatever command comes
      // next, and `x` is destructive.
      takeCount();
      log(
        `suppressed ${name}: chrome field focused ` +
          `<${el?.localName}${el?.id ? ` id=${el.id}` : ""}>`
      );
      return false;
    }
    const fn = cmds[name];
    if (!fn) return false;
    // ponytail: a count just runs the command N times. Right for every motion
    // we have (3j, 5J, 2x); a command that wanted the number itself — vim's
    // `42G` going to line 42 — would need to read it from cmds instead.
    const n = takeCount();
    try {
      for (let i = 0; i < n; i++) fn();
    } catch (ex) {
      log(`${name} failed: ${ex}`);
    }
    return true;
  }

  // Counts are capped rather than trusted: a fat-fingered `999x` should not
  // close a thousand tabs.
  function takeCount() {
    const n = Math.min(parseInt(count || "1", 10), COUNT_MAX);
    if (count && n < parseInt(count, 10)) log(`count ${count} clamped to ${n}`);
    count = "";
    updateEscape();
    return n;
  }

  // Translate a DOM keydown into the names used by BINDINGS / SEQUENCES.
  function keyNameFor(e) {
    if (e.key === "Escape") return e.shiftKey ? "Shift-Escape" : "Escape";
    if (e.key.length !== 1) return null; // F-keys, arrows, modifiers alone
    // Shift must be rejected, not ignored. Gecko refuses to ignore it for
    // letters (IsCaseChangeableChar) and the keyset honours that — but this
    // function feeds the layout fallback, which bypasses the keyset entirely.
    // Ctrl+Shift+V gives e.key "V", lowercased to "C-v", and the fallback then
    // dispatched passthrough. Same for Ctrl+Shift+W / U / D.
    if (e.shiftKey && (e.ctrlKey || e.altKey)) return null;
    if (e.ctrlKey && !e.altKey) return `C-${e.key.toLowerCase()}`;
    if (e.altKey && !e.ctrlKey) return `A-${e.key.toLowerCase()}`;
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    return e.key; // already the shifted character, e.g. "J" or ":"
  }

  // Is this key ours right now? Used by the layout fallback below, which must
  // not fire for keys we would ignore anyway. Escape and Shift-Escape are
  // deliberately excluded: their XUL keys are disabled on purpose most of the
  // time (normal mode hands Escape to the page), and a fallback would undo
  // exactly that.
  function isBound(name) {
    if (mode === "caret" && (CARET_MOTIONS[name] || CARET_EXTRA.has(name))) {
      return true;
    }
    if (pending) return !!SEQUENCES[pending][name];
    if (/^[1-9]$/.test(name) || (count && name === "0")) return true;
    return !!BINDINGS[name] || !!SEQUENCES[name];
  }

  // Modes the layout fallback runs in. Every mode that runs bindings belongs
  // here: gating on "normal" alone left keys the keyset missed dead in caret
  // mode while they worked fine in normal.
  const fallbackApplies = () => now().keys;

  // Which keys the fallback is willing to dispatch. Wider than isBound() on
  // purpose: a half-typed combo or count must be cancellable by ANY key, and an
  // unknown one is bound to nothing by definition — so the keyset registered no
  // <key> for it and isBound() said no, and `yf` sat pending until the combo
  // timeout instead of being thrown away. vim, Vimium and qutebrowser all drop
  // the sequence on the first key that does not continue it.
  const fallbackWants = (name) =>
    !!name && (isBound(name) || !!pending || !!count);

  // Bumped on every key the fallback is watching; dispatch() stamps it when the
  // keyset wins, which is how the two paths avoid running the same key twice.
  let keyToken = 0;
  // A SET, not one slot: two keydowns can both be processed before the first
  // setTimeout(0) runs (autorepeat, a stalled main thread), and a single slot
  // would then make key 1's timeout think it was unhandled and fire it twice.
  const keyHandled = new Set();

  // A caret motion, honouring any count. `caretSelecting` picks which half of
  // the pair runs — that is the whole of qutebrowser's `v` toggle.
  function caretDo(pair) {
    const cmd = pair[caretSelecting ? 1 : 0];
    const n = takeCount();
    try {
      for (let i = 0; i < n; i++) win.goDoCommand(cmd);
    } catch (ex) {
      log(`${cmd} failed: ${ex}`);
    }
  }

  // Returns true when the key was caret-mode's; false lets it fall through to
  // the normal bindings.
  function caretKey(keyName) {
    if (pending === "g") {
      setPending(null);
      if (keyName === "g") caretDo(["cmd_moveTop", "cmd_selectTop"]);
      return true;
    }
    if (keyName === "g") {
      setPending("g", { quiet: true });
      return true;
    }

    const motion = CARET_MOTIONS[keyName];
    if (motion) {
      caretDo(motion);
      return true;
    }

    switch (keyName) {
      case "v":
        // Space and Ctrl+Space are qutebrowser's aliases for this; both are
        // deliberately left alone here. Space is in the child's scroll
        // allowlist, and neither reaches dispatch() as a single character.
        caretSelecting = !caretSelecting;
        if (!caretSelecting) send("VimFox:ClearSelection");
        toast.show(caretSelecting ? "selection on" : "selection off");
        return true;
      case "o":
        send("VimFox:ReverseSelection");
        return true;
      case "y":
        // vim leaves visual mode after a yank, and so does qutebrowser.
        run("copySelection");
        setMode("normal");
        return true;
      case "c":
        setMode("normal");
        return true;
      // Uppercase HJKL scroll the page, exactly as qutebrowser has them.
      case "H": run("scrollLeft"); return true;
      case "J": run("scrollDown"); return true;
      case "K": run("scrollUp"); return true;
      case "L": run("scrollRight"); return true;
      // `/` prefills the findbar from the selection on its own — findbar's
      // startFind calls finder.getInitialSelection(), gated on
      // accessibility.typeaheadfind.prefillwithselection, which defaults true.
      case "/":
      case "?": run("find"); return true;
      case "n": run("findNext"); return true;
      case "N": run("findPrev"); return true;
    }
    return false;
  }

  function dispatch(keyName) {
    keyHandled.add(keyToken);

    // The one key passthrough mode does not hand to the page.
    if (keyName === "Shift-Escape") {
      setMode("normal");
      return;
    }

    // Caret mode runs its own keymap. Escape is excluded so the branch below
    // still owns leaving. Unmapped keys fall through to the normal bindings
    // rather than being swallowed, so nothing traps you in here.
    if (mode === "caret" && keyName !== "Escape" && caretKey(keyName)) return;

    if (keyName === "Escape") {
      // A half-typed count is the first thing Escape throws away.
      if (count) {
        count = "";
        updateEscape();
        return;
      }
      // Cancelling a combo is all Escape does here — don't also steal focus.
      if (pending) {
        setPending(null);
        return;
      }
      // Caret mode ends by dropping the selection; content's own
      // selectionchange then walks us back to normal.
      if (mode === "caret") {
        send("VimFox:ClearSelection");
        // Cleared optimistically: content reports transitions only, so a frame
        // with no selection sends nothing back and this would stay true.
        contentSelected = false;
        setMode("normal");
        return;
      }
      // Blur the content field too, else focus stays in the input and the next
      // focus event puts us straight back into insert mode.
      send("VimFox:Blur");
      if (chromeInputFocused()) {
        try {
          // The findbar (opened by / or ') needs closing, not reverting.
          const findbar = focusedFindbar();
          if (findbar) findbar.close();
          // Revert restores the page URL and closes the results panel, so one
          // Escape does what Firefox spreads over several presses.
          else win.gURLBar?.handleRevert?.();
        } catch (ex) {
          log(`escape from chrome field failed: ${ex}`);
        }
        gBrowser.selectedBrowser.focus();
      }
      setMode("normal");
      return;
    }
    if (pending) {
      const table = SEQUENCES[pending];
      setPending(null);
      const cmd = table?.[keyName];
      // `3gz` — a prefix followed by nothing. run() would have eaten the count;
      // without it the 3 survives onto whatever you press next, and `x` is
      // destructive.
      if (cmd) run(cmd);
      else takeCount();
      return;
    }

    // Digits before a command are a count. Only with no sequence pending — `g0`
    // and `g$` are bindings, not counts — and a leading 0 is not a count either.
    if (/^[0-9]$/.test(keyName) && (count || keyName !== "0")) {
      count += keyName;
      updateEscape(); // Escape now has a count to throw away
      return;
    }

    if (SEQUENCES[keyName]) {
      if (chromeInputFocused()) takeCount();
      else setPending(keyName);
      return;
    }
    const cmd = BINDINGS[keyName];
    if (cmd) run(cmd);
    // An unknown key throws a half-typed count away too, the same way an
    // unmatched sequence does — `3` then `f` must not leave the 3 armed for
    // whatever you press next, and `x` is destructive.
    else takeCount();
  }

  // ------------------------------------------------------- loaded parts ---
  // resource://vimfox/ resolves in the PARENT process only, which is exactly
  // where these run. Each part is a factory over one shared context, so the
  // dependency direction is written down instead of implied by closure order.
  const part = (name) => {
    const scope = {};
    Services.scriptloader.loadSubScript(`resource://vimfox/src/${name}.js`, scope);
    return scope;
  };

  // A context key window.js forgets to pass used to resolve to `undefined` and
  // throw at CALL time, from inside run()'s catch where nobody reads it — that
  // is exactly how Ctrl+W and n/N shipped dead. Every context goes through
  // here, so the destructure at the top of each module is now a LOAD-time
  // error naming the missing key. Only keys a module actually destructures are
  // read, so the lazy `vf.toast` / `vf.SEQUENCES` reads stay lazy.
  const strict = (ctx) =>
    new Proxy(ctx, {
      get(target, key) {
        if (!(key in target)) {
          throw new Error(`vimfox: context is missing "${String(key)}"`);
        }
        return target[key];
      },
    });

  const ui = part("ui").vimfoxUI(strict({
    win, document, HTML, log, TOAST_MS, initialMode: mode,
    // Lazy for the same reason as the tables below: which-key is created inside
    // this very module, so the toast cannot capture it at construction.
    hideWhichKey: () => whichKey.hide(),
    // Lazy: which-key reads these at show() time, and they come from the
    // commands module, which in turn needs this module's toast.
    get SEQUENCES() {
      return SEQUENCES;
    },
    get LABELS() {
      return LABELS;
    },
  }));
  const { indicator, chromeStyle, toast, whichKey, toolbox, toolboxObserver } = ui;

  const omnibar = part("omnibar").vimfoxOmnibar(strict({
    win, document, gBrowser, HTML, log, PlacesUtils,
    setMode, deleteLineIn,
    get mode() {
      return mode;
    },
    // Late-bound on purpose: the ex table below calls back into openInput,
    // which this module owns.
    runEx: (line) => runEx(line),
  }));
  const {
    palette, openInput, listTabs, listBookmarks, highlight,
    computeRelevancy, matchesAllTerms, DOMAIN_RELEVANCY, ONE_MONTH_MS,
  } = omnibar;

  // ------------------------------------------------------------ commands ---
  // Loaded before the keyset, which needs the binding tables. contentSelected
  // and lastTab are live getters: they are the mode machine's, and a copy
  // would go stale the moment the selection or the tab changed.
  const commands = (() => {
    const scope = {};
    Services.scriptloader.loadSubScript("resource://vimfox/src/commands.js", scope);
    return scope.vimfoxCommands(strict({
      win, document, gBrowser, log, send, deleteWordIn,
      // Plain references, not getters: these are window.js's own helpers and
      // nothing here is circular. Leaving them out made cmds.deleteWord and
      // findAgain throw ReferenceError on every use — Ctrl+W and n/N were dead,
      // and because C-w is ALWAYS_ON it had also permanently killed key_close.
      chromeField, focusedFindbar,
      SCROLL_LINES, TAB_DIGITS,
      setMode: (m) => setMode(m),
      get toast() {
        return toast;
      },
      get palette() {
        return palette;
      },
      listTabs: (...a) => listTabs(...a),
      listBookmarks: (...a) => listBookmarks(...a),
      listCommands: (...a) => listCommands(...a),
      get contentSelected() {
        return contentSelected;
      },
      get lastTab() {
        return lastTab;
      },
    }));
  })();
  const {
    cmds, BINDINGS, SEQUENCES, CARET_MOTIONS, CARET_EXTRA, ALWAYS_ON,
    CHROME_INPUT_OK, LABELS, yank, currentURI, openFind,
  } = commands;

  // ------------------------------------------------------------- keyset ---
  // Loaded before the parts below because everything about the mode machine
  // depends on it existing. dispatch is passed as a thunk: it is declared
  // further down, and the keyset only ever calls it after a real keypress.
  const keyset = (() => {
    const scope = {};
    Services.scriptloader.loadSubScript("resource://vimfox/src/keyset.js", scope);
    return scope.vimfoxKeyset(strict({
      document, log,
      dispatch: (k) => dispatch(k),
      BINDINGS, SEQUENCES, ALWAYS_ON, CARET_MOTIONS, CARET_EXTRA,
    }));
  })();


  // ------------------------------------------------------------- ex cmds ---

  // Ex commands as data, so the `:` menu and the executor read one table and
  // cannot drift — a command that is listed is a command that runs.
  const EX = {
    open:    { arg: "url", desc: "open in this tab",  run: (a) => openInput(a, "current") },
    tabopen: { arg: "url", desc: "open in a new tab", run: (a) => openInput(a, "tab") },
    q:       { desc: "close this tab",  run: () => cmds.tabClose() },
    reload:  { desc: "reload the page", run: () => cmds.reload() },
    restart: {
      desc: "restart Firefox",
      run: () =>
        Services.startup.quit(
          Services.startup.eAttemptQuit | Services.startup.eRestart
        ),
    },
  };

  function runEx(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const entry = EX[cmd];
    if (!entry) return log(`unknown command: ${cmd}`);
    // A throw here used to escape accept(), so close() never ran and the
    // palette stayed open in `command` mode — which is sticky, so refreshMode
    // refused to leave it. `:open` with no URL did exactly that.
    try {
      entry.run(rest.join(" "));
    } catch (ex) {
      log(`:${cmd} failed: ${ex}`);
    }
  }

  // Every command, shown the moment `:` opens and filtered as you type — the
  // same treatment gt gives tabs. Nothing to memorise.
  function listCommands() {
    return Object.entries(EX).map(([name, entry]) => ({
      source: "cmd",
      label: entry.arg ? `${name} {${entry.arg}}` : name,
      sub: entry.desc,
      name,
      arg: !!entry.arg,
    }));
  }

  // -------------------------------------------------------------- wiring ---

  win.VimFox = {
    onContentFocus,
    setMode,
    get mode() {
      return mode;
    },
    destroy() {
      // browse-with-caret is a GLOBAL pref and destroy() is the only path out
      // of caret mode that setMode does not cover. Closing the window with a
      // selection alive used to persist it as true, permanently.
      armCaret(false);
      win.messageManager.removeMessageListener("VimFox:Focus", onFocusMsg);
      win.messageManager.removeMessageListener("VimFox:Ready", onReadyMsg);
      win.messageManager.removeMessageListener("VimFox:Selection", onSelectionMsg);
      keyset.destroy();
      palette.destroy();
      whichKey.destroy();
      toast.destroy();
      toolboxObserver.disconnect();
      gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
      gBrowser.removeTabsProgressListener(tabsProgress);
      win.removeEventListener("focus", refreshMode, true);
      win.removeEventListener("mousedown", onChromeMousedown, true);
      win.removeEventListener("keydown", onWindowKeydown, true);
      // Cancels the combo and which-key timers as a side effect.
      setPending(null);
      indicator.remove();
      chromeStyle.remove();
      delete document.documentElement.dataset.vimfoxMode;
      delete win.VimFox;
    },
  };

  // Content focus -> mode. This window's own message manager, so the frame
  // script's messages arrive here with no browser-element -> window lookup.
  const onFocusMsg = (msg) =>
    onContentFocus(msg.data.editable, msg.data.userInitiated, msg.data.clicked);
  win.messageManager.addMessageListener("VimFox:Focus", onFocusMsg);

  // A newly loaded frame does not know the mode yet; tell it.
  const onReadyMsg = () => broadcastMode();
  win.messageManager.addMessageListener("VimFox:Ready", onReadyMsg);

  const onSelectionMsg = (msg) => onContentSelection(msg.data.hasSelection);
  win.messageManager.addMessageListener("VimFox:Selection", onSelectionMsg);

  // Focus moving within browser UI (urlbar, findbar, sidebar) has no content
  // event behind it, so reconcile on the chrome focus event instead. Only
  // "focus", not "blur": during a blur the focused element is briefly null,
  // which would flap the mode to normal and straight back.
  // Switching tabs always lands in normal mode. contentEditable tracks the
  // window, not the tab, so without this you inherit the previous tab's state
  // — and a new tab whose search box autofocuses would strand you in insert.
  // Whether a key command would reach the PAGE. `goDoCommand` resolves its
  // controller through `document.commandDispatcher`, which walks the focus
  // ring, so with focus parked anywhere in the chrome j/k/h/l scroll nothing
  // and stay silent about it until you click the page.
  //
  // Do NOT test this by asking the dispatcher for the controller: it falls back
  // to the CHROME window's own scroll controller and answers yes with a text
  // field focused. The self-test asserts that, because it is the shape of bug
  // this file keeps hitting — a call that happens and does nothing. A focused
  // remote <browser> is the chrome document's activeElement, so ask that.
  // (`selectedBrowser.controllers` is empty; there is nothing to ask directly.)
  const pageHasFocus = () => document.activeElement === gBrowser.selectedBrowser;

  // Shared by tab switch and same-tab navigation: both put a document in front
  // of you that the current mode knows nothing about. `fromLoad` is the one
  // difference — a tab switch is a deliberate move to another page and takes
  // focus with it, while a load can land mid-word in the urlbar (you typed a
  // URL there and the OLD page redirected), and must leave that alone.
  function resetForNewDocument(fromLoad) {
    if (now().sticky) return;
    contentEditable = false;
    // The new document has its own selection state, and content only reports
    // TRANSITIONS — so a stale true here put it straight back into caret mode
    // on the focus event that follows, with no way out.
    contentSelected = false;
    setMode(fromLoad && chromeInputFocused() ? "insert" : "normal");

    // Firefox focuses the urlbar for about:newtab, and it does so AFTER
    // TabSelect — so focusing content here synchronously gets overridden.
    // Defer, and re-check we are still in normal mode before stealing it back.
    win.setTimeout(() => {
      if (mode !== "normal") return;
      // Anything but the page holding focus: a chrome field, or nothing at all
      // — which is what our own omnibar leaves behind after `o`. The mode is
      // right and the keyset is live, and every scroll key is still a no-op
      // until you click the page.
      if (pageHasFocus()) return;
      gBrowser.selectedBrowser?.focus();
      refreshMode();
    }, 0);
  }

  const onTabSelect = (e) => {
    // Recorded before the early return, or `^` would forget every switch made
    // while passthrough was on.
    if (e.detail?.previousTab) lastTab = e.detail.previousTab;
    resetForNewDocument(false);
  };
  gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);

  // Caret mode must not survive a navigation: the caret and the selection both
  // die with the old document, so staying in caret leaves you in a mode with
  // nothing to move and no way for content to tell us — it only reports
  // selection TRANSITIONS, and there is no transition when the document goes.
  // qutebrowser resets the mode on load for the same reason. A tab switch
  // already did this; loading a page in the SAME tab did not.
  const onLocationChange = (browser, webProgress, _request, _uri, flags) => {
    if (browser !== gBrowser.selectedBrowser) return;
    if (!webProgress?.isTopLevel) return;
    // Anchor jumps and history.pushState keep the document, and the caret with
    // it. Only a real document swap should move the mode.
    if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) return;
    resetForNewDocument(true);
  };
  const tabsProgress = { onLocationChange };
  gBrowser.addTabsProgressListener(tabsProgress);

  win.addEventListener("focus", refreshMode, true);

  // Insert mode is holdFocus, so focus alone never leaves it. A CLICK does —
  // qutebrowser's input.insert_mode.auto_leave, which hangs off mousePress in
  // eventfilter.py and not off any focus event. This is the CHROME half of that
  // rule: clicking a toolbar button while the urlbar has focus must drop us
  // back to normal. Content clicks never reach this window (a remote browser
  // does not forward them), so they ride along on child.js's focus report
  // instead, as `clicked`.
  const leaveInsertOnClick = () => {
    if (mode === "insert" && !chromeInputFocused() && !contentEditable) {
      setMode("normal");
    }
  };
  const onChromeMousedown = () => {
    if (mode !== "insert") return;
    // Focus has not moved yet at mousedown; let it land, then re-check.
    win.setTimeout(leaveInsertOnClick, 0);
  };
  win.addEventListener("mousedown", onChromeMousedown, true);

  // The XUL keyset cannot win against browser-UI widgets: `reserved` only
  // governs whether *content* sees a key, and the urlbar's own keydown handler
  // runs on the element, ahead of window-level key handling. So Escape there
  // ran Firefox's multi-step chain (revert, close panel, ...) instead of ours.
  // Capture on the window is the earliest point in dispatch, so we get it
  // first and stop it dead.
  const onWindowKeydown = (e) => {
      // Parent-process pages (about:sessionrestore, about:tabcrashed) put
      // focus in a content document living in THIS process, so key events
      // target that document and the chrome keyset never matches them —
      // every binding died the moment such a page took focus. Remote pages
      // target the <browser> element instead, so they never reach this branch
      // and cannot be double-handled.
      // now().keys, not a hardcoded mode: in caret mode this branch was skipped,
      // so the key was dispatched by the fallback below but never suppressed —
      // it reached the page as well.
      if (now().keys && e.target && e.target.ownerDocument !== document) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const name = keyNameFor(e);
        if (name) dispatch(name);
        return;
      }

      // Layout fallback. The keyset should now match on any layout — we bind
      // the character, not a guessed physical key — but `e.key` is the ground
      // truth and costs nothing to check, so notice when the keyset did not
      // run and dispatch from here.
      //
      // Deliberately NOT the primary path: the keyset is `reserved`, so it beats
      // a hung content process, and that is the whole point of the project.
      // This only runs when the keyset produced nothing — deferred, because the
      // XUL key handler runs in the system group, after this capture listener.
      if (fallbackApplies() && !chromeInputFocused()) {
        const name = keyNameFor(e);
        if (fallbackWants(name)) {
          const token = ++keyToken;
          win.setTimeout(() => {
            const handled = keyHandled.delete(token);
            if (handled) return; // the keyset got it
            log(`keyset missed ${name}; dispatching from the layout fallback`);
            dispatch(name);
          }, 0);
        }
      }

      // command mode is the palette, which handles its own keys.
      if (mode !== "insert" || !chromeInputFocused()) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        dispatch("Escape");
        return;
      }

      // Tab / Shift+Tab in the findbar step through matches, exactly what F3
      // does — onFindAgainCommand is the same call F3 makes. Without this,
      // Tab would move focus out of the findbar instead.
      if (e.key === "Tab") {
        const findbar = focusedFindbar();
        if (!findbar) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        findbar.onFindAgainCommand(e.shiftKey);
      }
  };
  win.addEventListener("keydown", onWindowKeydown, true);

  win.addEventListener("unload", () => win.VimFox?.destroy(), { once: true });

  setMode("normal");
  log(`window ready (keyset has ${keyset.element.childElementCount} keys)`);

  // Self-test lives in its own file and is only loaded when asked for, so the
  // 600 lines of assertions cost a normal startup nothing. It reads the mode
  // machine's private state deliberately, hence the live getters.
  if (Services.env.get("VIMFOX_SELFTEST") === "1") {
    try {
      const scope = {};
      Services.scriptloader.loadSubScript(
        "resource://vimfox/src/selftest.js",
        scope
      );
      scope.vimfoxSelfTest(strict({
        win, document, gBrowser, HTML, log,
        BINDINGS, SEQUENCES, CARET_MOTIONS, CARET_EXTRA, CARET_PREF, COUNT_MAX,
        DOMAIN_RELEVANCY, ONE_MONTH_MS, EX, MODES,
        cmds, keyset, palette, toast, whichKey, indicator, chromeStyle, toolbox,
        dispatch, run, setMode, setPending, takeCount, isBound, caretKey,
        keyNameFor, chromeInputFocused, focusedChromeElement, refreshMode,
        onContentFocus, onContentSelection, listCommands, yank, onLocationChange,
        leaveInsertOnClick, pageHasFocus,
        fallbackApplies: (m) => !!MODES[m]?.keys,
        fallbackWants,
        deleteLineIn, deleteWordIn, highlight, matchesAllTerms, computeRelevancy,
        get mode() { return mode; },
        get pending() { return pending; },
        get caretSelecting() { return caretSelecting; },
        get caretArmed() { return caretArmed; },
        armCaret,
        get count() { return count; },
        set count(v) { count = v; },
        set contentEditable(v) { contentEditable = v; },
      }));
    } catch (ex) {
      log(`SELFTEST FAILED to load: ${ex}\n${ex.stack}`);
    }
  }
})();
