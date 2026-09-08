// vimfox/src/commands.js — what the keys actually do, and the tables that map
// keys to them.
//
// BINDINGS / SEQUENCES / CARET_MOTIONS live here rather than beside the keyset
// because they are the vocabulary, not the delivery mechanism. CARET_MOTIONS
// stores a PAIR per key — [move, select] — which is why arming the selection
// with `v` costs one array index instead of a second table.
//
// Anything reaching into gBrowser is an API-drift risk: moveTabTo grew an
// options object in FF152 and a bare index became a silent no-op. Prefer a
// self-test that observes the effect over one that trusts the call.

"use strict";

this.vimfoxCommands = (vf) => {
  const {
    win, document, gBrowser, log, send, deleteWordIn,
    chromeField, focusedFindbar,

    SCROLL_LINES, TAB_DIGITS,
    setMode,
  } = vf;

  const clipboardHelper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
    Ci.nsIClipboardHelper
  );

  const currentURI = () => gBrowser.selectedBrowser?.currentURI ?? null;

  function yank(text) {
    if (!text) {
      vf.toast.show("nothing to copy");
      return;
    }
    clipboardHelper.copyString(text);
    vf.toast.show(`copied  ${text}`);
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
    // FIND_NORMAL, not FIND_TYPEAHEAD: findbar.js arms _setFindCloseTimeout for
    // every mode EXCEPT normal, so quick-find closed itself after
    // accessibility.typeaheadfind.timeout (4s by default). `'` has to stay
    // FIND_LINKS to be links-only, and inherits that timeout.
    const open = (fb) =>
      fb?.startFind(linksOnly ? fb.FIND_LINKS : fb.FIND_NORMAL);
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
    // cmd_scrollLeft/Right DO exist — `strings libxul.so | grep ^cmd_scroll`.
    // These used to be content code (`content.scrollBy`), which scrolled only
    // the top-level window's root scroller: a wide table or a code block inside
    // a div never moved, and the message never reached an iframe at all. The
    // command dispatcher routes to whatever scroller actually has focus, which
    // is why j/k always worked and h/l did not.
    scrollLeft:  () => scrollCmd("cmd_scrollLeft", SCROLL_LINES),
    scrollRight: () => scrollCmd("cmd_scrollRight", SCROLL_LINES),

    // --- tabs -------------------------------------------------------------
    // Alternate tab. Firefox tracks no such thing, so TabSelect's own
    // previousTab is remembered below. Closed tabs are skipped, not resurrected.
    tabAlternate: () => {
      if (vf.lastTab?.isConnected) gBrowser.selectedTab = vf.lastTab;
    },
    windowNew:     () => win.OpenBrowserWindow(),
    windowPrivate: () => win.OpenBrowserWindow({ private: true }),
    tabClone:     () => gBrowser.duplicateTab(gBrowser.selectedTab),
    tabMoveLeft:  () => moveTab(-1),
    tabMoveRight: () => moveTab(1),
    tabFirst:     () => focusTabAt(0),
    tabLast:      () => focusTabAt(-1),
    tabMute:      () => gBrowser.selectedTab.toggleMuteAudio(),
    // Vimium's W. Firefox disables its own "Move Tab to New Window" on the last
    // tab, and replaceTabWithWindow there just relocates the window.
    tabDetach() {
      if (gBrowser.visibleTabs.length < 2) {
        vf.toast.show("only tab in this window");
        return;
      }
      gBrowser.replaceTabWithWindow(gBrowser.selectedTab);
    },

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
      if (!vf.contentSelected) {
        vf.toast.show("nothing to copy");
        return;
      }
      try {
        win.goDoCommand("cmd_copy");
        vf.toast.show("copied selection");
      } catch (ex) {
        log(`copySelection failed: ${ex}`);
      }
    },

    // qutebrowser's `v`: enter caret mode. Browse-with-caret is switched on by
    // the mode transition itself, and back off on the way out — it is no longer
    // a pref toggle you have to remember to undo.
    caretMode: () => setMode("caret"),

    passthrough: () => setMode("passthrough"),

    tabSelect:   () => vf.palette.open("tab", vf.listTabs()),
    bookmarks:   () => vf.palette.open("bookmark", vf.listBookmarks(), "current"),
    bookmarksTab:() => vf.palette.open("bookmark", vf.listBookmarks(), "tab"),
    open:        () => vf.palette.open("open", null, "current"),
    openTab:     () => vf.palette.open("open", null, "tab"),
    editUrl:     () =>
      vf.palette.open("open", null, "current",
        gBrowser.selectedBrowser.currentURI?.spec ?? ""),
    commandLine: () => vf.palette.open("ex", vf.listCommands()),

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
    W: "tabDetach",
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
    tabDetach: "move tab to a new window",
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

  return {
    cmds, BINDINGS, SEQUENCES, CARET_MOTIONS, CARET_EXTRA, ALWAYS_ON,
    CHROME_INPUT_OK, LABELS,
    // Reached for elsewhere: the ex table and the self-test.
    yank, currentURI, moveTab, openFind,
  };
};
