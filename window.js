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
  const SCROLL_LINES = 3;
  const SCROLL_STEP_X = 60;

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

  // Wrap query matches in <span class="match">, which Vimium's CSS renders
  // bold (and white in dark mode). Built from DOM nodes, never innerHTML —
  // this is a chrome document and titles/URLs are untrusted text.
  function highlight(parent, text, tokens) {
    parent.textContent = "";
    const lower = text.toLowerCase();

    const hits = [];
    for (const t of tokens) {
      for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) {
        hits.push([i, i + t.length]);
      }
    }

    if (!hits.length) {
      parent.textContent = text;
      return;
    }

    // Overlapping tokens ("git" and "hub" in "github") must not produce
    // nested or duplicated spans, so merge the ranges first.
    hits.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of hits) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }

    let pos = 0;
    for (const [s, e] of merged) {
      if (s > pos) parent.append(text.slice(pos, s));
      const m = document.createElementNS(HTML, "span");
      m.className = "match";
      m.textContent = text.slice(s, e);
      parent.append(m);
      pos = e;
    }
    if (pos < text.length) parent.append(text.slice(pos));
  }

  const clipboardHelper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
    Ci.nsIClipboardHelper
  );

  const currentURI = () => gBrowser.selectedBrowser?.currentURI ?? null;

  function yank(text) {
    if (!text) {
      toast.show("nothing to copy");
      return;
    }
    clipboardHelper.copyString(text);
    toast.show(`copied  ${text}`);
  }

  // Vimium's Suggestion.shortenUrl: decode and lowercase for display. Its
  // Google-specific query-param stripping is omitted — niche cleanup, and it
  // only ever applies to google.com result URLs.
  function shortenUrl(url) {
    try {
      return decodeURI(url).toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  function prettyURL() {
    const spec = currentURI()?.spec;
    if (!spec) return "";
    try {
      return decodeURI(spec);
    } catch {
      return spec; // malformed escapes; the raw form is better than nothing
    }
  }

  function readClipboard() {
    const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(
      Ci.nsITransferable
    );
    trans.init(null);
    // "text/plain" is current; "text/unicode" was the old name and still turns
    // up on some builds, so try both rather than guess.
    for (const flavor of ["text/plain", "text/unicode"]) {
      try {
        trans.addDataFlavor(flavor);
        Services.clipboard.getData(
          trans,
          Services.clipboard.kGlobalClipboard,
          gBrowser.selectedBrowser.browsingContext?.currentWindowContext ?? null
        );
        const out = {};
        trans.getTransferData(flavor, out);
        const text = out.value?.QueryInterface(Ci.nsISupportsString)?.data;
        if (text) return text;
      } catch {
        // Flavor absent or clipboard empty; fall through to the next.
      }
    }
    return "";
  }

  function openClipboard(where) {
    const text = readClipboard().trim();
    if (text) openInput(text, where);
    else log("clipboard is empty");
  }

  // Drop the fragment, then the query, then one path segment — so repeated
  // presses walk up rather than jumping straight to the origin.
  function urlUp(where) {
    const spec = currentURI()?.spec;
    if (!spec) return;
    try {
      const url = new win.URL(spec);
      if (url.hash) url.hash = "";
      else if (url.search) url.search = "";
      else {
        const parts = url.pathname.split("/").filter(Boolean);
        if (!parts.length) return; // already at the origin
        parts.pop();
        url.pathname = parts.length ? `/${parts.join("/")}/` : "/";
      }
      win.openTrustedLinkIn(url.href, where === "tab" ? "tab" : "current");
    } catch (ex) {
      log(`urlUp failed: ${ex}`);
    }
  }

  function openFind(linksOnly) {
    // Quick-find rather than the full bar, matching what `'` gave you before.
    const open = (fb) =>
      fb?.startFind(linksOnly ? fb.FIND_LINKS : fb.FIND_TYPEAHEAD);
    const cached = gBrowser.getCachedFindBar?.();
    if (cached) open(cached);
    else gBrowser.getFindBar?.()?.then(open, (ex) => log(`find failed: ${ex}`));
  }

  function findAgain(previous) {
    const findbar = focusedFindbar() ?? gBrowser.getCachedFindBar?.();
    if (findbar) findbar.onFindAgainCommand(previous);
  }

  function tabList() {
    return Array.from(gBrowser.visibleTabs ?? gBrowser.tabs).filter(
      (t) => !t.closing
    );
  }

  function focusTabAt(index) {
    const tabs = tabList();
    const tab = index < 0 ? tabs.at(index) : tabs[index];
    if (tab) gBrowser.selectedTab = tab;
  }

  function moveTab(dir) {
    const tab = gBrowser.selectedTab;
    const n = gBrowser.tabs.length;
    // Wraps, like J/K do when cycling tabs — pushing the last tab right sends
    // it to the front rather than stopping dead against the edge.
    const target = (tab._tPos + dir + n) % n;
    // FF152 takes an options object. A bare index destructures to undefined and
    // the call becomes a silent no-op — no error, the tab just sits there.
    gBrowser.moveTabTo(tab, { tabIndex: target });
  }

  function cycleTab(dir) {
    const tabs = tabList();
    const i = tabs.indexOf(gBrowser.selectedTab);
    if (i < 0 || !tabs.length) return;
    gBrowser.selectedTab = tabs[(i + dir + tabs.length) % tabs.length];
  }

  function scrollCmd(name, times = 1) {
    for (let i = 0; i < times; i++) {
      try {
        win.goDoCommand(name);
      } catch (ex) {
        log(`${name} failed: ${ex}`);
        return;
      }
    }
  }

  // ------------------------------------------------------------ commands ---

  const cmds = {
    scrollDown:  () => scrollCmd("cmd_scrollLineDown", SCROLL_LINES),
    scrollUp:    () => scrollCmd("cmd_scrollLineUp", SCROLL_LINES),
    halfDown:    () => scrollCmd("cmd_scrollPageDown"),
    halfUp:      () => scrollCmd("cmd_scrollPageUp"),
    top:         () => scrollCmd("cmd_scrollTop"),
    bottom:      () => scrollCmd("cmd_scrollBottom"),

    // Everything below runs entirely in the parent: immune to page load,
    // page jank, and hung tabs.
    // Walk the tab strip in the order it is drawn. advanceSelectedTab does not
    // reliably do that once pinned tabs / groups / hidden tabs are involved,
    // so index into visibleTabs, which is display order by definition.
    tabNext:     () => cycleTab(1),
    tabPrev:     () => cycleTab(-1),
    tabClose:    () => gBrowser.removeCurrentTab({ animate: false }),
    tabUndo:     () => SessionStore.undoCloseTab(win, 0),
    back:        () => gBrowser.selectedBrowser.goBack(),
    forward:     () => gBrowser.selectedBrowser.goForward(),
    reload:      () => gBrowser.reloadTab(gBrowser.selectedTab),

    focusInput:  () => send("VimFox:FocusInput"),

    // Ctrl+W. Chrome inputs (our palette, the urlbar) are edited directly so
    // we can fire an `input` event and keep the palette filter in sync;
    // content fields go through Firefox's own editor command.
    deleteWord() {
      const el = chromeField();
      if (el) deleteWordIn(el);
      else scrollCmd("cmd_deleteWordBackward");
    },


    // --- zoom / search / scroll -----------------------------------------
    zoomIn:      () => win.FullZoom.enlarge(),
    zoomOut:     () => win.FullZoom.reduce(),
    zoomReset:   () => win.FullZoom.reset(),
    findNext:    () => findAgain(false),
    findPrev:    () => findAgain(true),
    // `/` used to leak to the page — Google binds it to its own search box.
    find:        () => openFind(),
    findLinks:   () => openFind(true),
    scrollLeft:  () => send("VimFox:ScrollX", { dx: -SCROLL_STEP_X }),
    scrollRight: () => send("VimFox:ScrollX", { dx: SCROLL_STEP_X }),

    // --- tabs -------------------------------------------------------------
    // Alternate tab. Firefox tracks no such thing, so TabSelect's own
    // previousTab is remembered below. Closed tabs are skipped, not resurrected.
    tabAlternate: () => {
      if (lastTab?.isConnected) gBrowser.selectedTab = lastTab;
    },
    windowNew:     () => win.OpenBrowserWindow(),
    windowPrivate: () => win.OpenBrowserWindow({ private: true }),
    tabClone:     () => gBrowser.duplicateTab(gBrowser.selectedTab),
    tabMoveLeft:  () => moveTab(-1),
    tabMoveRight: () => moveTab(1),
    tabFirst:     () => focusTabAt(0),
    tabLast:      () => focusTabAt(-1),
    tabMute:      () => gBrowser.selectedTab.toggleMuteAudio(),

    // --- url / clipboard --------------------------------------------------
    urlUp:            () => urlUp("current"),
    urlUpTab:         () => urlUp("tab"),
    yankUrl:          () => yank(currentURI()?.spec),
    yankTitle:        () => yank(gBrowser.selectedTab.label),
    yankPretty:       () => yank(prettyURL()),
    yankMarkdown:     () => yank(`[${gBrowser.selectedTab.label}](${currentURI()?.spec})`),
    yankDomain:       () => {
      const uri = currentURI();
      yank(uri && `${uri.scheme}://${uri.hostPort}`);
    },
    openClipboard:    () => openClipboard("current"),
    openClipboardTab: () => openClipboard("tab"),

    // Fire Firefox's own Ctrl+D command rather than calling the handler
    // behind it, so this keeps working across the renames that API has had.
    bookmarkPage: () => {
      const cmd = document.getElementById("Browser:AddBookmarkAs");
      if (cmd) cmd.doCommand();
      else win.PlacesCommandHook?.bookmarkPage?.();
    },

    // The selection lives in the content process, so cmd_copy is routed there
    // rather than shipping the text across for the parent to copy.
    copySelection: () => {
      if (!contentSelected) {
        toast.show("nothing to copy");
        return;
      }
      try {
        win.goDoCommand("cmd_copy");
        toast.show("copied selection");
      } catch (ex) {
        log(`copySelection failed: ${ex}`);
      }
    },

    // qutebrowser's `v`: enter caret mode. Browse-with-caret is switched on by
    // the mode transition itself, and back off on the way out — it is no longer
    // a pref toggle you have to remember to undo.
    caretMode: () => setMode("caret"),

    passthrough: () => setMode("passthrough"),

    tabSelect:   () => palette.open("tab", listTabs()),
    bookmarks:   () => palette.open("bookmark", listBookmarks(), "current"),
    bookmarksTab:() => palette.open("bookmark", listBookmarks(), "tab"),
    open:        () => palette.open("open", null, "current"),
    openTab:     () => palette.open("open", null, "tab"),
    editUrl:     () =>
      palette.open("open", null, "current",
        gBrowser.selectedBrowser.currentURI?.spec ?? ""),
    commandLine: () => palette.open("ex", listCommands()),

    insertMode:  () => setMode("insert"),
  };

  // Key -> command. Two-key sequences live under `g`.
  const BINDINGS = {
    j: "scrollDown",
    k: "scrollUp",
    d: "halfDown",
    u: "halfUp",
    // Plain aliases for d / u. Line-killing lives in the palette's own key
    // handler, so page inputs and the urlbar keep their native Ctrl+U.
    "C-d": "halfDown",
    "C-u": "halfUp",
    "C-w": "deleteWord",
    G: "bottom",
    // Vimium's orientation: J goes left, K goes right.
    J: "tabPrev",
    K: "tabNext",
    x: "tabClose",
    X: "tabUndo",
    H: "back",
    L: "forward",
    h: "scrollLeft",
    l: "scrollRight",
    r: "reload",
    n: "findNext",
    N: "findPrev",
    "/": "find",
    "?": "find",
    "'": "findLinks",
    // Vimium's chord. `gl` below is an alias, for layouts where `^` is a dead
    // key and never arrives as a keypress at all.
    "^": "tabAlternate",
    "-": "zoomOut",
    "+": "zoomIn",
    "=": "zoomReset",
    v: "caretMode",
    M: "bookmarkPage",
    "C-v": "passthrough",
    "A-m": "tabMute",
    o: "open",
    O: "openTab",
    b: "bookmarks",
    B: "bookmarksTab",
    i: "insertMode",
    ":": "commandLine",
  };

  // qutebrowser's caret keymap. Each motion is a PAIR: move the caret, or
  // extend the selection while it is armed. That is exactly the shape Gecko's
  // command table has, so `v` toggling selection costs one array index.
  //
  // Not included, all of which need hand-written content JS Gecko has no
  // command for: `e` (end of word — cmd_wordNext is start of NEXT word),
  // `V` (line selection), and `[` / `]` (qutebrowser's four block motions;
  // only the paragraph pair below exists).
  const CARET_MOTIONS = {
    h: ["cmd_charPrevious", "cmd_selectCharPrevious"],
    l: ["cmd_charNext", "cmd_selectCharNext"],
    j: ["cmd_lineNext", "cmd_selectLineNext"],
    k: ["cmd_linePrevious", "cmd_selectLinePrevious"],
    w: ["cmd_wordNext", "cmd_selectWordNext"],
    b: ["cmd_wordPrevious", "cmd_selectWordPrevious"],
    0: ["cmd_beginLine", "cmd_selectBeginLine"],
    $: ["cmd_endLine", "cmd_selectEndLine"],
    G: ["cmd_moveBottom", "cmd_selectBottom"],
    "{": ["cmd_beginParagraph", "cmd_selectBeginParagraph"],
    "}": ["cmd_endParagraph", "cmd_selectEndParagraph"],
  };

  // Caret keys that are not motions. Needed by isBound(), so the layout
  // fallback still covers them if the keyset ever misses one.
  const CARET_EXTRA = new Set([
    "v", "o", "y", "c", "g", "/", "?", "n", "N", "H", "J", "K", "L",
  ]);

  // Multi-key sequences, keyed by their prefix. Any prefix listed here becomes
  // a pending state that which-key renders.
  const SEQUENCES = {
    g: {
      g: "top",
      i: "focusInput",
      t: "tabSelect",
      e: "editUrl",
      C: "tabClone",
      J: "tabMoveRight",
      K: "tabMoveLeft",
      0: "tabFirst",
      $: "tabLast",
      u: "urlUp",
      U: "urlUpTab",
      l: "tabAlternate",
    },
    w: {
      n: "windowNew",
      p: "windowPrivate",
    },
    y: {
      y: "yankUrl",
      t: "tabClone", // your alias; qutebrowser's yank-title moved to yT
      T: "yankTitle",
      d: "yankDomain",
      p: "yankPretty",
      m: "yankMarkdown",
    },
    p: { p: "openClipboard" },
    P: { p: "openClipboardTab" },
  };

  // Bindings that stay live in insert mode — editing keys are most useful
  // exactly when you are typing.
  const ALWAYS_ON = new Set(["C-w"]);

  // Alt-1..8 focus that tab, Alt-9 the last one.
  for (let n = 1; n <= TAB_DIGITS; n++) {
    const index = n === TAB_DIGITS ? -1 : n - 1;
    cmds[`tabFocus${n}`] = () => focusTabAt(index);
    BINDINGS[`A-${n}`] = `tabFocus${n}`;
  }

  // Commands allowed to fire while a chrome text field (palette, urlbar) has
  // focus. Everything else is suppressed there so normal-mode keys never
  // interfere with typing.
  const CHROME_INPUT_OK = new Set(["deleteWord"]);

  // Shown by which-key. Falls back to the command name if absent.
  const LABELS = {
    top: "scroll to top",
    focusInput: "focus first input",
    tabSelect: "tab search",
    editUrl: "edit current URL",
    tabClone: "clone tab",
    tabMoveRight: "move tab right",
    tabMoveLeft: "move tab left",
    tabFirst: "first tab",
    tabLast: "last tab",
    urlUp: "up one URL path",
    urlUpTab: "up one URL path (new tab)",
    tabAlternate: "last used tab",
    windowNew: "new window",
    windowPrivate: "new private window",
    yankUrl: "copy URL",
    yankTitle: "copy title",
    yankDomain: "copy domain",
    yankPretty: "copy decoded URL",
    yankMarkdown: "copy as markdown link",
    openClipboard: "open clipboard URL",
    openClipboardTab: "open clipboard URL in new tab",
  };

  // ---------------------------------------------------------------- mode ---

  let mode = "normal";
  let pending = null; // active sequence prefix, e.g. "g"
  let count = ""; // digits typed before a command, vim-style: 3j
  let lastTab = null; // the tab `^` goes back to
  let contentSelected = false; // page has a non-empty selection
  let caretSelecting = false; // caret motions extend the selection (`v`)
  let pendingTimer = 0;
  let whichKeyTimer = 0;

  // Escape is ours only when there is something to cancel: leaving insert
  // mode, or aborting a half-typed key combo. With neither pending it stays
  // disabled, so the page receives Escape as normal.
  function updateEscape() {
    keyset.setEscapeEnabled(
      mode === "insert" || mode === "caret" || !!pending || !!count
    );
    // Only passthrough mode needs a way out that the page cannot swallow.
    keyset.setPassthroughExitEnabled(mode === "passthrough");
  }

  // Single writer for the pending-prefix state, so the which-key panel and
  // Escape routing can never drift out of sync with it.
  function setPending(prefix) {
    pending = prefix;
    win.clearTimeout(pendingTimer);
    win.clearTimeout(whichKeyTimer);
    whichKey.hide();
    if (prefix) {
      pendingTimer = win.setTimeout(() => setPending(null), COMBO_TIMEOUT);
      whichKeyTimer = win.setTimeout(() => whichKey.show(prefix), WHICHKEY_DELAY);
    }
    updateEscape();
  }

  const CARET_PREF = "accessibility.browsewithcaret";
  let caretPrefWas = null;

  function armCaret(on) {
    try {
      if (on) {
        caretPrefWas = Services.prefs.getBoolPref(CARET_PREF, false);
        Services.prefs.setBoolPref(CARET_PREF, true);
        // Entering via a mouse selection arrives with one already made; via `v`
        // it does not, and motions should then just move the caret.
        caretSelecting = contentSelected;
      } else {
        if (caretPrefWas !== null) Services.prefs.setBoolPref(CARET_PREF, caretPrefWas);
        caretPrefWas = null;
        caretSelecting = false;
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
    keyset.setEnabled(mode === "normal" || mode === "caret");
    updateEscape();
    broadcastMode();
    log(`mode -> ${mode}`);
    // Bare word: the vim `-- INSERT --` dashes are redundant inside a chip.
    indicator.textContent = mode;
    indicator.dataset.mode = mode;
    // Drives the toolbar tint. On :root so the whole chrome can read it.
    document.documentElement.dataset.vimfoxMode = mode;
  }

  // Content needs the mode so it can swallow every key in normal mode. All
  // frames in the window, not just the selected tab — background tabs get no
  // keys anyway, and this avoids a stale frame waking up unswallowed.
  function broadcastMode() {
    try {
      win.messageManager.broadcastAsyncMessage("VimFox:Mode", { mode });
    } catch (ex) {
      log(`mode broadcast failed: ${ex}`);
    }
  }

  // Last editable state reported by the frame script, so chrome focus changes
  // can be reconciled against it without another IPC round trip.
  let contentEditable = false;

  function onContentFocus(editable, userInitiated) {
    if (!editable) {
      contentEditable = false;
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
    if (mode === "command" || mode === "passthrough") return;
    const editing = chromeInputFocused() || contentEditable;
    // A live selection holds caret mode. Focus events fire constantly while
    // dragging one out, and without this every one of them would drop us back
    // to normal before `y` could ever be pressed.
    if (!editing && contentSelected) return setMode("caret");
    setMode(editing ? "insert" : "normal");
  }

  // Content reports only the has/has-not transition; the text itself never
  // crosses the process boundary — cmd_copy runs where the selection lives.
  function onContentSelection(has) {
    contentSelected = has;
    if (has && mode === "normal") setMode("caret");
    else if (!has && mode === "caret") setMode("normal");
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
  const FALLBACK_MODES = new Set(["normal", "caret"]);

  // Bumped on every key the fallback is watching; dispatch() stamps it when the
  // keyset wins, which is how the two paths avoid running the same key twice.
  let keyToken = 0;
  let keyHandledToken = 0;

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
      setPending("g");
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
    keyHandledToken = keyToken;

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
      if (cmd) run(cmd);
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
      if (!chromeInputFocused()) setPending(keyName);
      return;
    }
    const cmd = BINDINGS[keyName];
    if (cmd) run(cmd);
  }

  // ------------------------------------------------------------- keyset ---
  // Every key that can *begin* or *continue* a normal-mode binding must be
  // registered, otherwise the second key of a sequence never reaches us.

  // There is NO layout table here, deliberately. Gecko already does the
  // translation: WidgetKeyboardEvent::GetShortcutKeyCandidates builds its
  // candidate list from mAlternativeCharCodes, which the widget layer fills in
  // from the OS keyboard layout at event time. The first and highest-priority
  // candidate is always PseudoCharCode() — the character the press actually
  // produced — matched against the modifiers exactly.
  //
  // The consequence that killed the old table: when Shift is held, candidates
  // are built ONLY from shifted char codes. The unshifted character of the same
  // physical key is never a candidate. So `<key key="=" modifiers="shift">`
  // could never match `+`, and every entry of the old SHIFTED map was either
  // dead or, in the one case that did match, firing the wrong command.
  //
  // So: bind the CHARACTER, both with and without shift, and let Gecko decide
  // which one the layout produces. Both dispatch the same command, so the two
  // elements cannot disagree, and it is correct on every layout by
  // construction rather than by a guess we would have to maintain.
  const isLetter = (ch) => ch.toLowerCase() !== ch.toUpperCase();

  const keyset = (() => {
    const el = document.createXULElement("keyset");
    el.id = "vimfox-keyset";

    const isCombo = (k) => /^[CA]-/.test(k);

    // Every prefix and every continuation key must be registered, or the
    // second key of a sequence never reaches us.
    const singles = new Set([
      ...Object.keys(BINDINGS).filter((k) => !isCombo(k)),
      ...Object.keys(SEQUENCES),
      ...Object.values(SEQUENCES).flatMap((table) => Object.keys(table)),
      // Count digits. 0 already arrives via g0, but 1-9 are bound to nothing on
      // their own and would never reach dispatch().
      ..."123456789",
      // Caret-mode keys that no normal binding already registers.
      ...Object.keys(CARET_MOTIONS),
      ...CARET_EXTRA,
    ]);

    const keys = [];
    // ALWAYS_ON chords: ours fires in every mode, so whatever they collide with
    // must stay dead in every mode.
    const alwaysKeys = [];

    const addKey = (attrs, cmdChar) => {
      const key = document.createXULElement("key");
      for (const [k, v] of Object.entries(attrs)) key.setAttribute(k, v);
      key.setAttribute("reserved", "true");
      key.addEventListener("command", () => dispatch(cmdChar));
      keys.push(key);
      el.appendChild(key);
    };

    for (const ch of singles) {
      if (isLetter(ch)) {
        // Letters are the one case Gecko will NOT ignore shift for
        // (IsCaseChangeableChar), so the case decides the modifier, and
        // Ctrl+Shift+C must never reach a Ctrl+C handler.
        addKey(ch === ch.toUpperCase() ? { key: ch, modifiers: "shift" } : { key: ch }, ch);
        continue;
      }
      // Everything else: bind the character both ways. Whichever the layout
      // needs is the one that matches, and both run the same command.
      addKey({ key: ch }, ch);
      if (!/[0-9]/.test(ch)) addKey({ key: ch, modifiers: "shift" }, ch);
    }

    for (const combo of Object.keys(BINDINGS).filter(isCombo)) {
      const key = document.createXULElement("key");
      key.setAttribute("key", combo.slice(2));
      key.setAttribute("modifiers", combo[0] === "A" ? "alt" : "accel");
      key.setAttribute("reserved", "true");
      key.addEventListener("command", () => dispatch(combo));
      // ALWAYS_ON bindings stay out of `keys`, which is what insert mode
      // disables — Ctrl+W must work precisely while you are typing.
      (ALWAYS_ON.has(combo) ? alwaysKeys : keys).push(key);
      el.appendChild(key);
    }


    // Escape is NOT in `keys` — it needs the opposite schedule to every other
    // binding, so setMode drives it separately:
    //   insert  -> enabled, we grab it to leave the mode
    //   normal  -> disabled, so the page receives Escape (modals, lightboxes)
    //   command -> disabled, the palette input's own DOM handler closes it
    const esc = document.createXULElement("key");
    esc.setAttribute("keycode", "VK_ESCAPE");
    esc.setAttribute("reserved", "true");
    esc.addEventListener("command", () => dispatch("Escape"));
    el.appendChild(esc);

    // The only key passthrough mode keeps for itself. Enabled solely in that
    // mode, so pages keep Shift+Escape the rest of the time.
    const passthroughExit = document.createXULElement("key");
    passthroughExit.setAttribute("keycode", "VK_ESCAPE");
    passthroughExit.setAttribute("modifiers", "shift");
    passthroughExit.setAttribute("reserved", "true");
    passthroughExit.addEventListener("command", () => dispatch("Shift-Escape"));
    el.appendChild(passthroughExit);

    document.documentElement.appendChild(el);
    // Dynamically added <key> elements are not picked up until the keyset is
    // re-inserted. Known XUL quirk, cheaper than fighting it.
    el.remove();
    document.documentElement.appendChild(el);

    // Firefox's own <key> elements beat ours for the same chord — reserved="true"
    // beats CONTENT, not other chrome keys. Ctrl+W was close-tab, Ctrl+D
    // bookmark, Ctrl+U view-source, Shift+Escape the process manager.
    //
    // Scanned over the keys we actually registered, NOT over BINDINGS: the
    // keycode bindings (Escape, Shift+Escape) are built by hand below the
    // BINDINGS loop, so a BINDINGS-driven scan cannot see them. That hole is
    // what left key_aboutProcesses live and made Shift+Escape open
    // about:processes instead of leaving passthrough mode.
    const chordOf = (k) => {
      const mods = (k.getAttribute("modifiers") || "").toLowerCase();
      return [
        k.getAttribute("keycode") || (k.getAttribute("key") || "").toLowerCase(),
        mods.includes("accel") || mods.includes("control"),
        mods.includes("alt"),
        mods.includes("shift"),
      ].join("/");
    };

    // Bare single-character keys are deliberately not scanned: nothing built-in
    // binds an unmodified letter, and matching them would drag in unrelated
    // <key key="..."> elements from panels.
    const builtins = new Map();
    const theirs = [...document.querySelectorAll("key")].filter(
      (k) => k.parentElement !== el
    );
    for (const ours of el.querySelectorAll("key")) {
      if (!ours.hasAttribute("modifiers") && !ours.hasAttribute("keycode")) continue;
      const chord = chordOf(ours);
      const hits = theirs.filter((k) => chordOf(k) === chord);
      if (hits.length) builtins.set(ours, hits);
    }

    const collisionsOf = (list) => list.flatMap((k) => builtins.get(k) ?? []);
    const builtinsNormal = collisionsOf(keys);
    const builtinsAlways = collisionsOf(alwaysKeys);

    for (const k of builtinsAlways) k.setAttribute("disabled", "true");
    log(
      `built-ins suppressed always: ${
        builtinsAlways.map((k) => k.id || "(anon)").join(", ") || "none"
      } | in normal mode: ${
        builtinsNormal.map((k) => k.id || "(anon)").join(", ") || "none"
      }`
    );

    const setDisabled = (node, off) =>
      off ? node.setAttribute("disabled", "true") : node.removeAttribute("disabled");

    // One of ours and its built-in twins always move in opposite directions:
    // whenever we are listening for a chord, Firefox is not, and the moment we
    // stop, it gets the chord back. Single writer, so the two cannot drift.
    const enable = (ours, on) => {
      setDisabled(ours, !on);
      for (const k of builtins.get(ours) ?? []) setDisabled(k, on);
    };

    // Startup state has to match `mode = "normal"` up front. setMode() returns
    // early when the mode is unchanged, so a window that opens in normal mode
    // never calls these — the built-ins would stay live until the first real
    // mode change, which is how Shift+Escape stayed Firefox's outside
    // passthrough too.
    for (const k of keys) enable(k, true);
    enable(esc, false);
    enable(passthroughExit, false);

    return {
      element: el,
      escape: esc,
      builtinsNormal,
      setEnabled(on) {
        for (const k of keys) enable(k, on);
      },
      passthroughExit,
      // Shift+Escape is the one key passthrough mode keeps for itself, so
      // key_aboutProcesses has to be dead for exactly as long as that mode
      // lasts — and live again the instant it ends.
      setPassthroughExitEnabled(on) {
        enable(passthroughExit, on);
      },
      setEscapeEnabled(on) {
        enable(esc, on);
      },
      destroy: () => el.remove(),
    };
  })();

  // ------------------------------------------------------------ data ---

  function listTabs() {
    return gBrowser.tabs
      .filter((t) => !t.closing)
      .map((t) => ({
        label: t.label || "(untitled)",
        sub: t.linkedBrowser?.currentURI?.spec ?? "",
        source: "tab",
        pick: () => (gBrowser.selectedTab = t),
      }));
  }

  async function listBookmarks() {
    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT b.title AS title, p.url AS url
         FROM moz_bookmarks b
         JOIN moz_places p ON b.fk = p.id
        WHERE b.type = :type
        ORDER BY p.frecency DESC
        LIMIT 2000`,
      { type: PlacesUtils.bookmarks.TYPE_BOOKMARK }
    );
    return rows.map((r) => ({
      label: r.getResultByName("title") || r.getResultByName("url"),
      sub: r.getResultByName("url"),
      url: r.getResultByName("url"),
      source: "bookmark",
    }));
  }

  // ---- Vimium's ranking, ported from background_scripts/completion/ranking.js
  // and the HistoryCompleter.computeRelevancy in completers.js. Frecency alone
  // ranked "World of Warcraft" (a title match) above warcraftlogs.com (a URL
  // match); this scores match quality per field instead.

  const MATCH_WEIGHTS = {
    matchAnywhere: 1,
    matchStartOfWord: 1,
    matchWholeWord: 1,
    maximumScore: 3, // sum of the three above, used to normalise
    recencyCalibrator: 2.0 / 3.0,
  };
  const ONE_MONTH_MS = 1000 * 60 * 60 * 24 * 30;

  const escapeRegex = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

  // Smartcase: case-insensitive unless the term itself contains a capital.
  const regexFor = (term, prefix = "", suffix = "") =>
    new RegExp(prefix + escapeRegex(term) + suffix, /[A-Z]/.test(term) ? "" : "i");

  function scoreTerm(term, string) {
    let score = 0;
    let count = 0;
    const nonMatching = string.split(regexFor(term));
    if (nonMatching.length > 1) {
      score = MATCH_WEIGHTS.matchAnywhere;
      count = nonMatching.reduce((p, c) => p - c.length, string.length);
      if (regexFor(term, "\\b").test(string)) {
        score += MATCH_WEIGHTS.matchStartOfWord;
        if (regexFor(term, "\\b", "\\b").test(string)) {
          score += MATCH_WEIGHTS.matchWholeWord;
        }
      }
    }
    return [score, Math.min(count, string.length)];
  }

  function normalizeDifference(a, b) {
    const max = Math.max(a, b);
    return max === 0 ? 0 : (max - Math.abs(a - b)) / max;
  }

  function wordRelevancy(terms, url, title) {
    let urlScore = 0;
    let titleScore = 0;
    let urlCount = 0;
    let titleCount = 0;

    for (const term of terms) {
      let [s, c] = scoreTerm(term, url);
      urlScore += s;
      urlCount += c;
      if (title) {
        [s, c] = scoreTerm(term, title);
        titleScore += s;
        titleCount += c;
      }
    }

    const maximumPossibleScore = MATCH_WEIGHTS.maximumScore * terms.length;

    urlScore /= maximumPossibleScore;
    urlScore *= normalizeDifference(urlCount, url.length);

    if (title) {
      titleScore /= maximumPossibleScore;
      titleScore *= normalizeDifference(titleCount, title.length);
    } else {
      titleScore = urlScore;
    }

    // Don't let a poor urlScore drag down a good titleScore — a long URL
    // scores badly on length alone.
    if (urlScore < titleScore) urlScore = titleScore;

    return (urlScore + titleScore) / 2;
  }

  // Quadratic falloff; anything older than a month scores 0.
  function recencyScore(lastVisitMs) {
    if (!lastVisitMs) return 0;
    const recency = Date.now() - lastVisitMs;
    const d = Math.max(0, ONE_MONTH_MS - recency) / ONE_MONTH_MS;
    return d * d * d * MATCH_WEIGHTS.recencyCalibrator;
  }

  function computeRelevancy(terms, url, title, lastVisitMs) {
    const recency = recencyScore(lastVisitMs);
    if (!terms.length) return recency;
    const relevancy = wordRelevancy(terms, url, title);
    // Recency can pull a score up but never down.
    return (relevancy + Math.max(recency, relevancy)) / 2;
  }

  // Vimium's ranking.matches: every term must appear in the url or the title.
  // Applied after the SQL filter so smartcase is honoured.
  const matchesAllTerms = (terms, url, title) =>
    terms.every((t) => regexFor(t).test(url) || regexFor(t).test(title || ""));

  // Vimium's DomainCompleter. For a single-word query it contributes exactly
  // one suggestion — the best-matching domain — with a fixed relevancy of 2.0,
  // which outranks every history suggestion (those score in [0,1]). That fixed
  // score, not the ranking maths, is what puts raider.io above a page merely
  // titled "raid".
  const DOMAIN_RELEVANCY = 2.0;

  async function searchDomain(query) {
    // Single-word queries only — /\S\s/ in Vimium.
    if (!query || /\S\s/.test(query)) return null;
    const term = query.trim();
    if (!term) return null;

    const db = await PlacesUtils.promiseDBConnection();
    // moz_origins is already a domain table: prefix is "https://", host the
    // domain, so no grouping or URL parsing needed.
    const rows = await db.executeCached(
      `SELECT o.prefix || o.host AS domain,
              MAX(p.last_visit_date) AS lastVisit
         FROM moz_origins o
         JOIN moz_places p ON p.origin_id = o.id
        WHERE p.hidden = 0 AND LOWER(o.host) LIKE :q ESCAPE '\\'
        GROUP BY o.id
        ORDER BY o.frecency DESC
        LIMIT 100`,
      { q: `%${term.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%` }
    );

    const scored = rows
      .map((r) => {
        const domain = r.getResultByName("domain");
        const lastVisit = (r.getResultByName("lastVisit") ?? 0) / 1000;
        const relevancy = wordRelevancy([term], domain, null);
        return {
          domain,
          // Same combination the history completer uses.
          score: (relevancy + Math.max(recencyScore(lastVisit), relevancy)) / 2,
        };
      })
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return null;
    const { domain } = scored[0];
    return {
      label: "", // no title line — the domain is the whole suggestion
      sub: domain,
      url: domain,
      source: "domain",
      score: DOMAIN_RELEVANCY,
    };
  }

  // History + bookmarks. SQL is only a coarse filter — frecency picks the
  // candidate pool, then Vimium's scoring decides the order.
  async function searchPlaces(query, limit = 40) {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .map((t) => t.replace(/[%_\\]/g, (c) => `\\${c}`));

    if (!tokens.length) return [];

    const where = tokens
      .map(
        (_, i) =>
          `(LOWER(p.url) LIKE :t${i} ESCAPE '\\' OR ` +
          `LOWER(IFNULL(p.title,'')) LIKE :t${i} ESCAPE '\\')`
      )
      .join(" AND ");

    // Pull a wide candidate pool: the best-scoring row is often not among the
    // top few by frecency, which is the whole reason the old ordering was
    // wrong. Ranking happens below, in JS.
    const params = { limit: Math.max(limit * 10, 300) };
    tokens.forEach((t, i) => (params[`t${i}`] = `%${t}%`));

    const db = await PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT p.url AS url,
              IFNULL(NULLIF(b.title,''), IFNULL(NULLIF(p.title,''), p.url)) AS title,
              p.last_visit_date AS lastVisit,
              (b.id IS NOT NULL) AS bookmarked
         FROM moz_places p
         LEFT JOIN moz_bookmarks b ON b.fk = p.id AND b.type = :type
        WHERE p.hidden = 0 AND ${where}
        ORDER BY p.frecency DESC
        LIMIT :limit`,
      { ...params, type: PlacesUtils.bookmarks.TYPE_BOOKMARK }
    );

    // Raw terms, not the LIKE-escaped ones — the regexes do their own escaping,
    // and smartcase needs the original capitalisation.
    const terms = query.split(/\s+/).filter(Boolean).slice(0, 4);

    return rows
      .map((r) => {
        const url = r.getResultByName("url");
        const title = r.getResultByName("title");
        // moz_places stores microseconds.
        const lastVisit = (r.getResultByName("lastVisit") ?? 0) / 1000;
        return {
          label: title,
          sub: url,
          url,
          source: r.getResultByName("bookmarked") ? "bookmark" : "history",
          score: computeRelevancy(terms, url, title, lastVisit),
          _url: url,
          _title: title,
        };
      })
      .filter((it) => matchesAllTerms(terms, it._url, it._title))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  function openInput(text, where) {
    const fixup = Services.uriFixup.getFixupURIInfo(
      text,
      Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS |
        Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP
    );
    const uri = fixup.preferredURI;
    if (!uri) return;
    win.openTrustedLinkIn(uri.spec, where === "tab" ? "tab" : "current");
  }

  // -------------------------------------------------------- command line ---
  // A chrome element, not an injected iframe. It therefore renders above every
  // page including about:*, survives fullscreen, and cannot be styled or
  // blocked by page CSS.

  const palette = (() => {
    // Vimium's own DOM shape, so its stylesheet applies unmodified:
    //   #vomnibar > #vomnibar-search-area > input
    //   #vomnibar > ul > li > .top-half/.bottom-half
    const bar = document.createElementNS(HTML, "div");
    bar.id = "vomnibar";
    bar.setAttribute("hidden", "true");

    const searchArea = document.createElementNS(HTML, "div");
    searchArea.id = "vomnibar-search-area";

    const input = document.createElementNS(HTML, "input");
    input.setAttribute("type", "text");

    const list = document.createElementNS(HTML, "ul");

    searchArea.append(input);
    bar.append(searchArea, list);

    // Loaded as a file rather than inlined, so it stays a verbatim copy.
    const style = document.createElementNS(HTML, "link");
    style.setAttribute("rel", "stylesheet");
    style.setAttribute("href", "resource://vimfox/vomnibar.css");

    // Overrides layered on top of the verbatim copy, so that file stays a
    // clean diff against upstream.
    const hideRule = document.createElementNS(HTML, "style");
    hideRule.textContent = `
      /* The copied CSS hard-sets display:block; Vimium destroys the element
         rather than hiding it, so it has no [hidden] rule of its own. */
      #vomnibar[hidden] { display: none; }

      /* Vimium's geometry comes from its host iframe (iframe.vomnibar-frame in
         content_scripts/vimium.css): top:70px, width:calc(80% + 20px),
         min-width:400px, centred via left:50%/margin-left:-40%, with the bar
         itself 8px down inside the frame — so 78px below the top of the
         CONTENT viewport.

         We are position:fixed inside browser.xhtml, where y=0 is the top of
         the window, above the tab strip and toolbars. So the real offset is
         measured from the content area at open() time; these are only
         fallbacks for before that runs. */
      #vomnibar {
        top: 78px;
        left: 50%;
        transform: translateX(-50%);
        width: 80%;
        min-width: 400px;
      }

      /* The iframe used to bound the list height; without it a long result
         set would run off the bottom of the screen. */
      #vomnibar ul { max-height: 60vh; overflow-y: auto; }
    `;

    document.documentElement.append(style, hideRule, bar);

    let items = [];
    let filtered = [];
    let sel = 0;
    let kind = "ex";
    let where = "current";
    let lookupToken = 0;
    // Vimium's initialSelectionValue: -1 for the omni completer, so nothing is
    // selected until you Tab and Enter uses exactly what you typed. The tab and
    // bookmark palettes have no meaningful "raw text" action, so they start at 0.
    let initialSel = -1;

    // Align to the content viewport, the way Vimium's iframe is. Measured on
    // every open so it survives toolbar changes, a sidebar, and fullscreen.
    function position() {
      const r = gBrowser.selectedBrowser?.getBoundingClientRect();
      if (!r?.width) return; // keep the CSS fallback

      bar.style.top = `${r.top + 78}px`;
      bar.style.left = `${r.left + r.width / 2}px`;
      bar.style.width = `${Math.max(r.width * 0.8, 400)}px`;
      bar.style.maxHeight = `${Math.max(r.height - 88, 200)}px`;
    }

    function render() {
      list.textContent = "";
      // The copied `#vomnibar ul { display: none }` means the list only shows
      // when we say so — same as Vimium, whose JS drives this too.
      list.style.display = filtered.length ? "block" : "none";

      const tokens = input.value
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

      filtered.slice(0, 200).forEach((it, i) => {
        const el = document.createElementNS(HTML, "li");
        if (i === sel) {
          el.className = "selected";
          // The list scrolls now, so keep the selection visible.
          win.requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
        }

        // Vimium's layout (Suggestion.generateHtml):
        //   top-half:    <span.source>type</span><span.title>title</span>
        //   bottom-half: <span.url>url</span>
        // The type belongs beside the TITLE, not beside the URL.
        const top = document.createElementNS(HTML, "div");
        top.className = "top-half";

        const src = document.createElementNS(HTML, "span");
        src.className = "source";
        src.textContent = it.source ?? "";
        top.append(src);

        const title = document.createElementNS(HTML, "span");
        title.className = "title";
        highlight(title, it.label ?? "", tokens);
        top.append(title);

        const bottom = document.createElementNS(HTML, "div");
        bottom.className = "bottom-half";
        const url = document.createElementNS(HTML, "span");
        url.className = "url";
        highlight(url, shortenUrl(it.sub ?? ""), tokens);
        bottom.append(url);

        el.append(top, bottom);
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          sel = i;
          accept();
        });
        list.append(el);
      });
    }

    function filter() {
      // `open` queries Places on each keystroke rather than filtering a
      // preloaded list — the history table is far too big to hold in memory.
      if (kind === "open") {
        lookup();
        return;
      }

      const q = input.value.trim().toLowerCase();
      filtered = !q
        ? items
        : items.filter(
            (it) =>
              it.label.toLowerCase().includes(q) ||
              (it.sub ?? "").toLowerCase().includes(q)
          );
      sel = initialSel;
      render();
    }

    // Vimium's mechanism exactly (pages/vomnibar_page.js updateCompletions):
    // fire on every keystroke with no debounce, do NOT touch the DOM on the
    // way in, and render once — when results arrive. The previous list stays
    // on screen until it is replaced in a single write, so there is never an
    // empty frame. Stale replies are dropped by request id, as Vimium does
    // with lastRequestId.
    async function lookup() {
      const token = ++lookupToken;
      const text = input.value.trim();

      if (!text) {
        filtered = [];
        sel = initialSel;
        render();
        return;
      }

      let rows = [];
      try {
        // Both completers run against the same query, as Vimium does, and are
        // merged by score — the domain's fixed 2.0 always lands it first.
        const [domain, places] = await Promise.all([
          searchDomain(text),
          searchPlaces(text),
        ]);
        rows = domain
          ? [domain, ...places.filter((p) => p.url !== domain.url)]
          : places;
      } catch (ex) {
        log(`lookup failed: ${ex}`);
      }
      if (token !== lookupToken || kind !== "open") return;

      filtered = rows;
      sel = initialSel;
      render();
    }

    // Vimium's wrapping: past the end returns to initialSel (for `open`, that
    // is "nothing selected"), and stepping back from there lands on the last
    // row rather than being clamped.
    function move(dir) {
      if (!filtered.length) return;
      sel += dir;
      if (sel >= filtered.length) sel = initialSel;
      else if (sel < initialSel) sel = filtered.length - 1;
      render();
    }

    function close() {
      bar.setAttribute("hidden", "true");
      input.value = "";
      items = filtered = [];
      list.textContent = "";
      setMode("normal");
      gBrowser.selectedBrowser.focus();
    }

    function accept() {
      const text = input.value.trim();
      const choice = filtered[sel];

      if (kind === "tab" && choice) {
        choice.pick();
      } else if (kind === "bookmark" && choice) {
        win.openTrustedLinkIn(choice.url, where === "tab" ? "tab" : "current");
      } else if (kind === "open") {
        // Nothing selected (sel === -1) means use exactly what was typed.
        if (choice?.url) {
          win.openTrustedLinkIn(choice.url, where === "tab" ? "tab" : "current");
        } else if (text) {
          openInput(text, where);
        }
      } else if (kind === "ex") {
        if (choice) {
          // Picking a command that needs an argument completes the line rather
          // than running it — selecting `open` should let you type the URL, not
          // open the empty string.
          if (choice.arg) {
            input.value = `${choice.name} `;
            filter();
            return;
          }
          runEx(choice.name);
        } else if (text) {
          runEx(text);
        }
      }
      close();
    }

    input.addEventListener("keydown", (e) => {
      // Tab must move the selection, not hand focus to the next XUL widget.
      // stopPropagation as well as preventDefault: XUL focus traversal runs
      // ahead of the default action, so preventDefault alone does not hold it.
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        move(e.shiftKey ? -1 : 1);
        return;
      }

      // Ctrl+U clears the command line. Handled here rather than as a binding
      // so it is scoped to the palette and nothing else.
      if (e.ctrlKey && e.key === "u") {
        e.preventDefault();
        e.stopPropagation();
        deleteLineIn(input);
        return;
      }

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "Enter":
          e.preventDefault();
          accept();
          break;
        case "n":
          if (!e.ctrlKey) return;
        // fallthrough
        case "ArrowDown":
          e.preventDefault();
          move(1);
          break;
        case "p":
          if (!e.ctrlKey) return;
        // fallthrough
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          break;
      }
    });

    input.addEventListener("input", filter);

    // Chrome popups — the translations panel is the usual culprit, but the
    // permission and password prompts do it too — grab focus while the bar is
    // open. Take it back. Vimium does the same in vomnibar_page.js.
    // Deferred so the stealing widget has finished focusing before we undo it,
    // and re-checked so closing the bar (which hides it first) doesn't loop.
    input.addEventListener("blur", () => {
      if (bar.hasAttribute("hidden")) return;
      win.setTimeout(() => {
        if (!bar.hasAttribute("hidden") && mode === "command") input.focus();
      }, 0);
    });

    return {
      async open(k, source, dest, prefill) {
        kind = k;
        where = dest ?? "current";
        initialSel = k === "open" || k === "ex" ? -1 : 0;
        sel = initialSel;
        setMode("command");
        // Vimium has no sigil element, so the hint goes in the placeholder.
        input.setAttribute(
          "placeholder",
          k === "ex" ? ":" : k === "open" ? (dest === "tab" ? "tabopen" : "open") : k
        );
        position();
        bar.removeAttribute("hidden");
        items = filtered = [];
        render();
        input.value = prefill ?? "";
        input.focus();
        // Cursor at the end, not selecting the text — ge is for editing the
        // URL, so a stray keystroke must not wipe it.
        input.setSelectionRange(input.value.length, input.value.length);

        if (source) {
          items = typeof source.then === "function" ? await source : source;
          filter();
        } else if (input.value) {
          filter(); // ge prefills a URL; show matches for it straight away
        }
      },
      close,
      destroy() {
        bar.remove();
        style.remove();
        hideRule.remove();
      },
    };
  })();

  // Mode indicator. Lives INSIDE the address bar's input row, as a sibling of
  // Firefox's own search-mode chip (#urlbar-search-mode-indicator), so it
  // reads as part of the chrome instead of an overlay pasted over it.
  const indicator = document.createElementNS(HTML, "span");
  indicator.id = "vimfox-mode";

  const chromeStyle = document.createElementNS(HTML, "style");
  chromeStyle.textContent = `
    /* Address bar stays where Firefox puts it. To move it to the BOTTOM,
       uncomment this: browser.xhtml's <body> is a flex column with
       #navigator-toolbox and #browser as plain siblings, so reordering is the
       whole trick — no reparenting, nothing for Firefox to undo.
       #navigator-toolbox { order: 1; } */

    /* One source for the mode colour: the chip and the toolbar both read it.
       :root carries the mode so the toolbar can be styled without reaching
       into the chip. */
    /* Plain hex per scheme, NOT light-dark(): a light-dark() value nested
       inside color-mix() computes to transparent, which silently killed the
       toolbar tint while leaving the chip's own text colour working.
       NB: this block lives in a JS template literal — no backticks. */
    :root[data-vimfox-mode="normal"]      { --vimfox-accent: #2b6cb0; }
    :root[data-vimfox-mode="insert"]      { --vimfox-accent: #2f855a; }
    :root[data-vimfox-mode="command"]     { --vimfox-accent: #975a16; }
    :root[data-vimfox-mode="passthrough"] { --vimfox-accent: #6b46c1; }
    :root[data-vimfox-mode="caret"]       { --vimfox-accent: #b83280; }
    @media (prefers-color-scheme: dark) {
      :root[data-vimfox-mode="normal"]      { --vimfox-accent: #7cacf8; }
      :root[data-vimfox-mode="insert"]      { --vimfox-accent: #5bc98d; }
      :root[data-vimfox-mode="command"]     { --vimfox-accent: #e3b04b; }
      :root[data-vimfox-mode="passthrough"] { --vimfox-accent: #b98cf7; }
      :root[data-vimfox-mode="caret"]       { --vimfox-accent: #f478bd; }
    }

    /* Whole-toolbar tint. Translucent ON TOP of whatever the theme painted,
       rather than replacing --toolbox-background-color: themes write that
       variable as an INLINE style on :root, so overriding it would need
       !important and would throw the user's theme away. In the default
       (non-nova) layout #navigator-toolbox has no background of its own — the
       colour comes from <body> underneath — so a translucent one layers.
       Turn the tint down or off with this one number. */
    #navigator-toolbox {
      /* Literal percentage: a var() in color-mix's percentage slot resolved to
         0% and the tint silently vanished. Turn the strength up or down here. */
      background-color: color-mix(in srgb, var(--vimfox-accent) 22%, transparent);
      transition: background-color 120ms ease-out;
    }
    /* Normal mode is where you live, so the toolbar keeps the theme's own
       colour. The chip still says NORMAL in blue; only the panel goes quiet. */
    :root[data-vimfox-mode="normal"] #navigator-toolbox { background-color: transparent; }

    #vimfox-mode {
      display: flex;
      align-items: center;
      margin-inline: 6px 2px;
      padding: 3px 7px;
      border-radius: var(--urlbar-inner-border-radius, 4px);
      font: 600 10px/1 system-ui, sans-serif;
      letter-spacing: .08em;
      text-transform: uppercase;
      white-space: nowrap;
      pointer-events: none;
      background: color-mix(in srgb, var(--vimfox-accent) 16%, transparent);
      color: var(--vimfox-accent);
    }

    /* Fallback only: the address bar is the least stable API in Firefox (see
       CLAUDE.md), so if its input row ever disappears the chip becomes a
       corner badge again rather than vanishing. */
    #vimfox-mode[detached] {
      position: fixed; bottom: 0; inset-inline-end: 0; z-index: 2147483646;
      background: var(--vimfox-accent); color: #fff;
      border-start-start-radius: 4px;
    }

    #vimfox-whichkey {
      position: fixed; inset-inline-end: 0; bottom: var(--vimfox-chrome-bottom, 22px);
      z-index: 2147483646;
      font: 12px/1.7 monospace; padding: 6px 10px; pointer-events: none;
      border-start-start-radius: 6px;
      background: light-dark(#fff, #1c1b22);
      color: light-dark(#15141a, #fbfbfe);
      border: 1px solid light-dark(#d7d7db, #3a3944);
      box-shadow: 0 2px 12px rgba(0,0,0,.3);
    }
    #vimfox-whichkey[hidden] { display: none; }
    #vimfox-whichkey b {
      display: inline-block; min-width: 1.6em; font-weight: 700;
      color: light-dark(#2b6cb0, #7cacf8);
    }
    #vimfox-whichkey span { opacity: .75; }

    #vimfox-toast {
      position: fixed; inset-inline-end: 0; bottom: var(--vimfox-chrome-bottom, 22px);
      z-index: 2147483646;
      font: 12px/1.7 monospace; padding: 6px 10px; pointer-events: none;
      border-start-start-radius: 6px;
      background: light-dark(#fff, #1c1b22);
      color: light-dark(#15141a, #fbfbfe);
      border: 1px solid light-dark(#d7d7db, #3a3944);
      box-shadow: 0 2px 12px rgba(0,0,0,.3);
      max-width: 45vw; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    #vimfox-toast[hidden] { display: none; }
  `;

  // Transient confirmation, bottom-right. Shares the which-key slot: a yank
  // always clears the pending prefix, so the two never show at once.
  const toast = (() => {
    const box = document.createElementNS(HTML, "div");
    box.id = "vimfox-toast";
    box.setAttribute("hidden", "true");
    let timer = 0;

    return {
      element: box,
      show(text) {
        box.textContent = text;
        box.removeAttribute("hidden");
        win.clearTimeout(timer);
        timer = win.setTimeout(() => box.setAttribute("hidden", "true"), TOAST_MS);
      },
      destroy() {
        win.clearTimeout(timer);
        box.remove();
      },
    };
  })();

  // which-key: on a pending prefix, show what can follow it.
  const whichKey = (() => {
    const box = document.createElementNS(HTML, "div");
    box.id = "vimfox-whichkey";
    box.setAttribute("hidden", "true");

    return {
      element: box,
      // Rows are built per prefix, so adding a sequence needs no work here.
      show(prefix) {
        const table = SEQUENCES[prefix];
        if (!table) return;
        box.textContent = "";
        for (const [key, cmd] of Object.entries(table)) {
          const row = document.createElementNS(HTML, "div");
          const k = document.createElementNS(HTML, "b");
          k.textContent = prefix + key;
          const d = document.createElementNS(HTML, "span");
          d.textContent = LABELS[cmd] ?? cmd;
          row.append(k, d);
          box.append(row);
        }
        box.removeAttribute("hidden");
      },
      hide: () => box.setAttribute("hidden", "true"),
      destroy: () => box.remove(),
    };
  })();

  document.documentElement.append(chromeStyle, whichKey.element, toast.element);

  // window.js runs on the window's load event, so <html:moz-urlbar> has already
  // built its input row by now — no retry needed.
  const urlbarRow = document.querySelector("#urlbar .urlbar-input-container");
  // Paint the starting mode. setMode() returns early when the mode is
  // unchanged, so nothing else would until the first real switch.
  indicator.textContent = mode;
  indicator.dataset.mode = mode;
  document.documentElement.dataset.vimfoxMode = mode;

  if (urlbarRow) {
    urlbarRow.append(indicator);
  } else {
    log("urlbar input row missing; mode chip detached");
    indicator.setAttribute("detached", "");
    document.documentElement.append(indicator);
  }

  // which-key and toasts hug the bottom edge. Whether the toolbox is in the
  // way is MEASURED, not assumed, so moving the address bar top-to-bottom
  // stays a one-line CSS change. Height also shifts in fullscreen and when the
  // bookmarks toolbar toggles. body is observed too: it resizes with the
  // window, which is what moves the bottom edge.
  const toolbox = document.getElementById("navigator-toolbox");
  const updateChromeInset = () => {
    const box = toolbox.getBoundingClientRect();
    const atBottom = box.bottom >= win.innerHeight - 1;
    document.documentElement.style.setProperty(
      "--vimfox-chrome-bottom",
      atBottom ? `${box.height + 6}px` : "22px"
    );
  };
  const toolboxObserver = new win.ResizeObserver(updateChromeInset);
  if (toolbox) {
    // Once up front: ResizeObserver does not deliver until the next frame, and
    // the self-test runs before that.
    updateChromeInset();
    toolboxObserver.observe(toolbox);
    toolboxObserver.observe(document.body);
  }

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
    entry.run(rest.join(" "));
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
      win.messageManager.removeMessageListener("VimFox:Focus", onFocusMsg);
      win.messageManager.removeMessageListener("VimFox:Selection", onSelectionMsg);
      keyset.destroy();
      palette.destroy();
      whichKey.destroy();
      toast.destroy();
      toolboxObserver.disconnect();
      indicator.remove();
      chromeStyle.remove();
      delete document.documentElement.dataset.vimfoxMode;
      delete win.VimFox;
    },
  };

  // Content focus -> mode. This window's own message manager, so the frame
  // script's messages arrive here with no browser-element -> window lookup.
  const onFocusMsg = (msg) =>
    onContentFocus(msg.data.editable, msg.data.userInitiated);
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
  gBrowser.tabContainer.addEventListener("TabSelect", (e) => {
    // Recorded before the early return, or `^` would forget every switch made
    // while passthrough was on.
    if (e.detail?.previousTab) lastTab = e.detail.previousTab;
    if (mode === "passthrough" || mode === "command") return;
    contentEditable = false;
    setMode("normal");

    // Firefox focuses the urlbar for about:newtab, and it does so AFTER
    // TabSelect — so focusing content here synchronously gets overridden.
    // Defer, and re-check we are still in normal mode before stealing it back.
    win.setTimeout(() => {
      if (mode !== "normal") return;
      if (!chromeInputFocused()) return;
      gBrowser.selectedBrowser?.focus();
      refreshMode();
    }, 0);
  });

  win.addEventListener("focus", refreshMode, true);

  // The XUL keyset cannot win against browser-UI widgets: `reserved` only
  // governs whether *content* sees a key, and the urlbar's own keydown handler
  // runs on the element, ahead of window-level key handling. So Escape there
  // ran Firefox's multi-step chain (revert, close panel, ...) instead of ours.
  // Capture on the window is the earliest point in dispatch, so we get it
  // first and stop it dead.
  win.addEventListener(
    "keydown",
    (e) => {
      // Parent-process pages (about:sessionrestore, about:tabcrashed) put
      // focus in a content document living in THIS process, so key events
      // target that document and the chrome keyset never matches them —
      // every binding died the moment such a page took focus. Remote pages
      // target the <browser> element instead, so they never reach this branch
      // and cannot be double-handled.
      if (mode === "normal" && e.target && e.target.ownerDocument !== document) {
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
      if (FALLBACK_MODES.has(mode) && !chromeInputFocused()) {
        const name = keyNameFor(e);
        if (name && isBound(name)) {
          const token = ++keyToken;
          win.setTimeout(() => {
            if (keyHandledToken === token) return; // the keyset got it
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
    },
    true
  );

  win.addEventListener("unload", () => win.VimFox?.destroy(), { once: true });

  setMode("normal");
  log(`window ready (keyset has ${keyset.element.childElementCount} keys)`);

  // Run with VIMFOX_SELFTEST=1 to check the wiring without a human pressing
  // keys. It cannot verify key *delivery* — that is the one thing only a real
  // keypress (or Marionette) proves — but it catches every dangling binding,
  // broken mode transition, and missing element.
  if (Services.env.get("VIMFOX_SELFTEST") === "1") {
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
      }
    }
    // A prefix that also has a top-level binding would shadow the sequence.
    for (const prefix of Object.keys(SEQUENCES)) {
      check(`prefix "${prefix}" is also a direct binding`, !BINDINGS[prefix]);
    }

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
      document.documentElement.dataset.vimfoxMode === mode
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
    check("combo survived Escape", !pending);
    check(
      "Escape not released again after cancelling combo",
      escEl.hasAttribute("disabled")
    );
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
    check(`count did not accumulate (count=${count})`, count === "12");
    check("Escape not grabbed while a count is pending", !escEl.hasAttribute("disabled"));
    dispatch("Escape");
    check(`Escape did not clear the count (count=${count})`, count === "");
    dispatch("3");
    check("takeCount did not read the buffer", takeCount() === 3);
    check(`count not cleared after use (count=${count})`, count === "");
    // A leading 0 is g0's key, never a count.
    dispatch("0");
    check(`leading 0 started a count (count=${count})`, count === "");
    check("count not clamped", (() => { count = "999"; return takeCount() === COUNT_MAX; })());
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

    // Middle-click closes a tab. vimfox blocks no mouse events anywhere — but
    // the pinned-tab patch in autoconfig.cfg WRAPS Firefox's on_click, and
    // anything thrown in that wrapper takes the built-in handler with it. That
    // is how middle-click-to-close died on every tab.
    {
      const extra = gBrowser.addTab("about:blank", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      extra.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, button: 1, view: win })
      );
      // removeTab animates, so the tab is marked closing before it is gone.
      check(
        `middle click did not close the tab (autoconfig pinned-tab patch ` +
          `applied: ${!!gBrowser.tabContainer._pinnedMclickPatched})`,
        extra.closing || !extra.isConnected
      );
      if (extra.isConnected && !extra.closing) gBrowser.removeTab(extra);
    }

    // Caret mode. Driven entirely by content's selection report, so drive it
    // the same way here.
    setMode("normal");
    onContentSelection(true);
    check(`selection did not enter caret mode (mode=${mode})`, mode === "caret");
    check(
      "caret mode disabled the keyset — y could never be pressed",
      !keyEl.hasAttribute("disabled")
    );
    check("Escape not grabbed in caret mode", !escEl.hasAttribute("disabled"));
    // `y` must shadow the y* sequence prefix while a selection is alive.
    dispatch("y");
    check(`y in caret mode started a sequence instead of yanking (pending=${pending})`, !pending);
    // vim leaves visual mode on yank; so does qutebrowser.
    check(`y did not leave caret mode (mode=${mode})`, mode === "normal");
    onContentSelection(false);
    check(`losing the selection did not leave caret mode (mode=${mode})`, mode === "normal");
    // ...and y goes back to being a prefix.
    focusedChromeElement()?.blur?.();
    dispatch("y");
    check("y stopped being a sequence prefix outside caret mode", pending === "y");
    setPending(null);
    check("caret mode has no chip colour", chromeStyle.textContent.includes('mode="caret"'));

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
    check("`v` into caret mode should not start armed", caretSelecting === false);
    caretKey("v");
    check("`v` did not arm the selection", caretSelecting === true);
    caretKey("v");
    check("`v` did not disarm the selection", caretSelecting === false);
    check(
      "browse-with-caret not on in caret mode",
      Services.prefs.getBoolPref(CARET_PREF, false)
    );
    setMode("normal");
    check("browse-with-caret not restored on leaving caret mode", caretPrefWas === null);
    // Unmapped keys must fall through, or caret mode traps you.
    setMode("caret");
    check("caret mode swallowed an unmapped key", caretKey("x") === false);
    setMode("normal");

    // Caret mode must be in the layout fallback, or every AltGr key dies there
    // while working fine in normal mode — which is exactly how `$` behaved.
    check("caret mode is not covered by the layout fallback", FALLBACK_MODES.has("caret"));
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
    check(`page-initiated focus entered insert mode (mode=${mode})`, mode === "normal");
    onContentFocus(true, true);
    check(`user-initiated focus did not enter insert (mode=${mode})`, mode === "insert");
    // ...but once in insert, a page refocusing its own field must not eject us.
    onContentFocus(true, false);
    check(`page refocus ejected us from insert (mode=${mode})`, mode === "insert");
    onContentFocus(false, false);
    check(`leaving the field did not exit insert (mode=${mode})`, mode === "normal");
    contentEditable = false;

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
      `chrome input did not enter insert mode (mode=${mode})`,
      mode === "insert" || !chromeInputFocused()
    );
    probeField.remove();
    contentEditable = false;
    refreshMode();

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
    // Any enabled built-in sharing one of our chords will win over ours.
    for (const combo of Object.keys(BINDINGS).filter((k) => /^[CA]-/.test(k))) {
      const ch = combo.slice(2).toLowerCase();
      const clash = [...document.querySelectorAll("key")].find((k) => {
        if (k.closest("#vimfox-keyset")) return false;
        if ((k.getAttribute("key") || "").toLowerCase() !== ch) return false;
        const mods = (k.getAttribute("modifiers") || "").toLowerCase();
        if (mods.includes("shift")) return false;
        const isAlt = mods.includes("alt");
        const wantAlt = combo[0] === "A";
        if (wantAlt ? !isAlt : !(mods.includes("accel") || mods.includes("control")))
          return false;
        return !k.hasAttribute("disabled");
      });
      check(
        `built-in key still active for ${combo} (#${clash?.id || "anon"})`,
        !clash
      );
    }

    // ...and they must come back when we stop listening, or insert mode loses
    // Ctrl+V paste, Ctrl+D bookmark and so on.
    setMode("insert");
    check(
      "built-ins not restored in insert mode",
      keyset.builtinsNormal.every((k) => !k.hasAttribute("disabled"))
    );
    setMode("normal");
    check(
      "built-ins not re-suppressed in normal mode",
      keyset.builtinsNormal.every((k) => k.hasAttribute("disabled"))
    );
    check(
      "C-w disabled in insert mode",
      !keyset.element
        .querySelector('key[key="w"][modifiers="accel"]')
        ?.hasAttribute("disabled")
    );

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

    const tst = document.getElementById("vimfox-toast");
    check("toast missing", !!tst);
    check("toast visible before any yank", tst?.hasAttribute("hidden"));
    toast.show("probe");
    check("toast did not appear", !tst?.hasAttribute("hidden"));
    check("toast text wrong", tst?.textContent === "probe");
    tst?.setAttribute("hidden", "true");

    for (const prefix of Object.keys(SEQUENCES)) {
      dispatch(prefix);
      check(`prefix "${prefix}" not pending`, pending === prefix);
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
    check(`Shift-Escape did not leave passthrough (mode=${mode})`, mode === "normal");
    check(
      "passthrough exit key still armed in normal mode",
      keyset.passthroughExit.hasAttribute("disabled")
    );

    log(
      fails.length
        ? `SELFTEST FAILED (${fails.length}): ${fails.join("; ")}`
        : "SELFTEST PASSED"
    );
  }
})();
