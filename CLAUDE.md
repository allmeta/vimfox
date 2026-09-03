# CLAUDE.md — vimfox domain knowledge

Hard-won facts. Most were bugs first. Read before changing anything.

## Shape

```
autoconfig.cfg (root, /usr/lib/firefox)
  └─ boot.js            parent process, chrome privilege
       ├─ resource://vimfox/  → ~/.vimfox   (PARENT ONLY)
       ├─ child.js  read by parent, shipped to content as data: URI
       └─ window.js loaded per browser.xhtml window
            └─ src/{ui,omnibar,commands,keyset,selftest}.js
```

Each `src/` part is a factory over one shared context object, loaded with
`loadSubScript` into a throwaway scope — `resource://vimfox/` resolves in the
PARENT process, which is where all of this runs.

Load order is ui → omnibar → commands → keyset, and it matters: **destructuring
a context object READS its getters**. Anything that could be circular is left on
`vf` and read at call time instead — `vf.toast` and `vf.palette` in commands,
`vf.SEQUENCES` and `vf.LABELS` in ui. ui needs the binding tables from commands,
and commands needs ui's toast; lazy on both sides is what breaks the cycle.

Mode lives in the parent. Parent is authoritative. Content only reports focus.

## Where things live

| file | what it owns | do NOT put here |
|---|---|---|
| `window.js` | MODES table, `setMode`/`dispatch`/`run`/counts, focus reconciliation, the ex table, all wiring and listeners | anything a keypress *does* |
| `src/commands.js` | `cmds` bodies, `BINDINGS`/`SEQUENCES`/`CARET_MOTIONS`/`LABELS`, tab and scroll helpers | mode decisions; it must not know what mode it is |
| `src/keyset.js` | `<key>` elements, layout matching, built-in collision pairing | anything about what a key *means* |
| `src/omnibar.js` | palette DOM and behaviour, Places queries, Vimium ranking, `highlight`/`shortenUrl`/`openInput` | anything not the palette |
| `src/ui.js` | chip, which-key, toast, injected stylesheet, `paintMode` | reading the mode — it is TOLD, via `paintMode` |
| `src/selftest.js` | every assertion | anything the product needs at runtime |
| `child.js` | content: focus + selection reporting, key swallowing, `gi`, horizontal scroll | any mode logic; it is told `swallow`, it does not decide |
| `boot.js` | `resource://` registration, frame script, per-window attach | features |
| `system/` | the two root-owned files. **Editing these does nothing until `sudo system/install.sh`** | |

Rough sizes: window.js ~840, omnibar ~700, selftest ~740, commands ~430,
child ~325, ui ~230, keyset ~225. Nothing should grow past ~800 without being
split; that is what made the first refactor necessary.

## Adding things

- **A binding**: `cmds` entry + `BINDINGS`/`SEQUENCES` row + `LABELS` row, all in
  `src/commands.js`. The self-test checks all three agree AND calls the command.
- **A caret key**: `CARET_MOTIONS` if it is a motion (a `[move, select]` PAIR),
  else an arm in `caretKey` in window.js, and add it to `CARET_EXTRA` or the
  layout fallback will not fire for it.
- **A mode**: one `MODES` row, plus an accent colour in `ui.js`. The self-test
  fails if you do only one.
- **An ex command**: the `EX` table in window.js. It is a SEPARATE system from
  `cmds` — see the open items below.

## Open — known broken or missing

Ordered by how much they bite. Nothing here is subtle; these are all known.

**Correctness**

- `keyset.destroy()` removes our keyset but leaves every built-in it suppressed
  still `disabled`. Moot on unload, wrong if `destroy()` is ever called for
  anything else.
- `send()` targets `gBrowser.selectedBrowser.messageManager`, which reaches only
  the TOP-LEVEL frame. `VimFox:ClearSelection` never arrives in an iframe, so a
  selection made inside one cannot be cleared from the parent.

**Missing features**

- No link hints (`f`). Cross-origin iframes under Fission need parent-side hint
  allocation; it is a project of its own and the largest single gap.
- Caret mode lacks `e`, `V`, and qutebrowser's four `[`/`]` block motions. Gecko
  has no command for any of them — only the paragraph pair `{`/`}`. Each needs
  hand-written content JS.
- No marks, quickmarks, or `.` repeat.
- The `o` omnibar does not offer open tabs, and there are no per-engine search
  keywords (`:open g foo`).
- Paths are hardcoded to `/home/thomal` in `boot.js` and `autoconfig.cfg`.

**Structural, in the order that would pay off**

1. **`cmds` and `EX` are two command systems.** `:q` re-declares `cmds.tabClose`
   with its own description. Give `cmds` entries optional `label`/`ex`/`arg`
   metadata and derive `LABELS` and `EX` from it — then a new command is
   bindable, discoverable in which-key, and typeable at `:` for free.
2. `caretKey` is a switch parallel to `CARET_MOTIONS`. One table whose values are
   a motion pair, a command name, or a function would make it one row per key and
   let the self-test iterate it.
3. Four hand-rolled `loadSubScript` call sites; `part()` exists and is used by
   one of them. Every one of them now also repeats `strict({...})` by hand.
4. The self-test is one long function. A two-line `group(name, fn)` would tag
   failures with their section.
5. Constants are threaded through the context one at a time. One `CONFIG` object
   would shrink every destructure and is the natural seam for a real config file.
6. **`child.js` has zero coverage.** Every assertion runs in the parent; the
   content half — swallow allowlist, selection reporting, `gi` — is untested and
   is the harder half to debug.

## Environment traps

- `general.config.sandbox_enabled=false` REQUIRED. Else `Cc is not defined`
  and nothing loads. Lives in `defaults/pref/autoconfig.js`, NOT `user.js` —
  AutoConfig runs before profile prefs.
- `Services` is a global. `Services.sys.mjs` was REMOVED. Don't import it.
- `IOUtils` does NOT exist in AutoConfig scope. Use nsIFileInputStream +
  nsIConverterInputStream.
- `dump()` needs `browser.dom.window.dump.enabled`. `logStringMessage` does
  NOT reach stdout. Without the pref, failures are invisible.

## Why frame script, not JSWindowActor

Content sandbox refuses to read `~/.vimfox`. Actor child ESM = content process
load = `Failed to load resource://vimfox/VimFoxChild.sys.mjs`, once per doc.
Parent reads the file, ships source as `data:` URI. Do not "fix" this back to
an actor.

`resource://` substitutions are per-process. Parent only. Content never
resolves `resource://vimfox/`.

## XUL keys

- `reserved="true"` = parent handles before CONTENT. Does NOT beat other
  CHROME keys.
- Firefox built-ins win otherwise. Must disable colliding `<key>` elements.
  Found by scanning, not hardcoded ids.
- `C-w` must NEVER close a tab. It is `ALWAYS_ON` (delete word matters most
  while typing), so its twin `key_close` is permanently dead. The self-test
  asserts BOTH halves in every mode — ours live, theirs disabled — because the
  pair is only correct together.
- Suppression is MODE-SCOPED except `ALWAYS_ON`. `key_paste` collides with
  `C-v`; killing it permanently breaks Ctrl+V in the urlbar. Only `key_close`
  is permanently dead (C-w is ALWAYS_ON).
- The collision scan runs over the `<key>` elements WE REGISTERED, never over
  `BINDINGS`. The two keycode keys (Escape, Shift+Escape) are built by hand
  outside that table, and a BINDINGS-driven scan cannot see them — which left
  `key_aboutProcesses` live and made Shift+Escape open about:processes instead
  of leaving passthrough mode. `key_stop` is the same collision on plain
  Escape.
- Each of our keys and its built-in twins move as one pair through `enable()`:
  ours on means theirs off, always. **Suppressing is synchronous, releasing is
  deferred one tick.** Ours are `reserved` and run before content, Firefox's are
  not and run after, so both passes see the same keydown — a synchronous release
  handed the very key that changed mode to the built-in too, and `C-v` entered
  passthrough AND pasted. `flushBuiltins()` recomputes every pair from the live
  `disabled` state, so repeated changes in one tick settle rather than race; the
  self-test calls it before asserting any release. Bare unmodified characters are skipped —
  nothing built-in binds a plain letter.
- Initial state is set explicitly when the keyset is built. `setMode()` returns
  early when the mode is unchanged, so a window opening in normal mode never
  calls the setters, and anything left at its default stays wrong until the
  first real mode change.
- Dynamically added `<key>` needs keyset remove + re-append to register.
- **There is no layout table, and there must not be one.** Gecko already
  translates: `WidgetKeyboardEvent::GetShortcutKeyCandidates`
  (`widget/WidgetEventImpl.cpp`) builds candidates from
  `mAlternativeCharCodes`, which the widget layer fills from the OS layout at
  event time. Candidate 0 is always `PseudoCharCode()` — the character the
  press actually produced.
- **When Shift is held, candidates come ONLY from shifted char codes.** The
  unshifted character of the same physical key is never a candidate. So
  `<key key="=" modifiers="shift">` can NEVER match `+`. The old `SHIFTED`
  table was entirely dead code except for its one live mis-fire: `?` listed
  `+`, and `key="+" modifiers="shift"` matched candidate 0 of Shift+`=`, so
  `+` ran find instead of zooming.
- **So bind the CHARACTER, both with and without shift**, and let the layout
  decide which matches. Both elements dispatch the same command, so they cannot
  disagree. Correct on every layout by construction; nothing to maintain.
- Letters are the exception — `IsCaseChangeableChar` means Gecko will not
  ignore shift for them, so case picks the modifier. That is deliberate:
  Ctrl+Shift+C must never reach a Ctrl+C handler.
- Digits get the bare form only, so Shift+digit cannot start a count.

## Where the keyset does NOT fire

- **Non-remote about: pages** (`about:sessionrestore`, `about:tabcrashed`).
  Document lives in parent process, key events target IT, keyset never
  matches. Fallback: window capture listener, gated on
  `e.target.ownerDocument !== document`. Remote pages target `<browser>`, so
  no double-handling.
- **Chrome widgets** (urlbar, findbar). Their own keydown handlers run before
  window-level key handling. Escape/Tab there need the capture listener too.

## Focus is a minefield

- `Services.focus.focusedElement` returns CONTENT elements on non-remote
  pages. Always check `ownerDocument === document`. Missing this made `run()`
  suppress every binding on about: pages — silent, no error.
- Insert mode = text field focused, content OR chrome. Urlbar counts, else
  Escape falls to Firefox's multi-press chain.
- Page-initiated focus is IGNORED (qutebrowser `insert_mode.auto_load=false`).
  Content timestamps mousedown/keydown; focus without a gesture in 300ms does
  not enter insert. `gi` must `markGesture()` itself — its keypress is eaten
  in the parent, content sees nothing.
- Already in insert: accept page refocus. Only ENTERING is gated.
- **Focus never LEAVES insert mode.** `insert` is `holdFocus`, same as caret.
  qutebrowser has no focus-driven exit at all: `input.insert_mode.auto_leave`
  hangs off `mousePress` in `browser/eventfilter.py`, and its description says
  "if a non-editable element is **clicked**". The four ways out are Escape,
  a click on a non-editable element, a page load
  (`input.insert_mode.leave_on_load`), and — ours, not qutebrowser's — a tab
  switch. Nothing else. kagi's `j`/`k` walk the results by FOCUSING each link:
  focus-driven exit ended insert mode on the first keystroke, and normal mode
  then swallowed the second.
- The click rule needs BOTH halves, because a remote browser's mousedown never
  reaches the chrome window. Content clicks: `child.js` timestamps mousedown
  separately from keydown and ships `clicked` on the focus report — a keystroke
  that makes the page move focus is a gesture but NOT a click, which is the
  whole distinction. Chrome clicks: a window `mousedown` capture listener,
  deferred one tick because focus has not moved yet at mousedown.
- Same-tab navigation forces normal too, via a `TabsProgressListener`
  `onLocationChange` that shares `resetForNewDocument()` with `TabSelect`.
  Gated on the SELECTED browser, `isTopLevel`, and NOT
  `LOCATION_CHANGE_SAME_DOCUMENT` — an anchor jump or `pushState` keeps the
  document, and the caret with it. Without it, loading a page left you in caret
  mode with no caret: content reports only selection TRANSITIONS, and there is
  no transition when the document itself goes away.
- `TabSelect` forces normal + defers focus steal-back. Firefox focuses the
  urlbar AFTER TabSelect, so a synchronous focus() is overridden.
- Listen to `focus` only, never `blur` — mid-blur focusedElement is null and
  the mode flaps. Content has the same hazard from the other side: `focusout`
  fires with activeElement already back on `<body>`, so reporting it directly
  said "not editable" and dropped insert mode, and the `focusin` that followed
  was gated out as page-initiated — leaving you in normal mode with a field
  focused. `child.js` coalesces focusin/focusout into ONE deferred report of
  the settled state.

## Caret mode

A page selection puts the window in `caret`. It is NORMAL MODE WITH A SELECTION
ALIVE, not a separate keymap: the keyset stays enabled and content keeps
swallowing keys, or `y` would type into the page.

- Content reports only the has/has-not TRANSITION. `selectionchange` fires on
  every mouse move during a drag, and the parent needs one boolean. The
  selected text NEVER crosses the process boundary — `goDoCommand("cmd_copy")`
  routes to where the selection lives.
- Listen on `selectionchange` AND `mouseup`/`keyup`. selectionchange does not
  fire for every way a selection can end; the transition guard makes the extra
  calls free.
- `refreshMode()` must return caret while a selection is alive. Focus events
  fire constantly while dragging one out, and each would otherwise drop the
  mode back to normal before `y` could be pressed.
- The keymap is qutebrowser's (`configdata.yml`, `bindings.default.caret`).
  `CARET_MOTIONS` holds a PAIR per key — `[move, select]` — because Gecko has
  both variants of every motion, so `v` toggling selection is one array index.
  Verify against `strings libxul.so | grep '^cmd_select'`; the commands are not
  in omni.ja.
- Caret mode sets `accessibility.browsewithcaret`, and **`clearUserPref`s it on
  exit — it does NOT restore a remembered value.** Without a caret there is
  nothing for the motions to move. The pref is GLOBAL and `armCaret`'s state is
  per-window, so remembering the previous value leaked: two windows both in
  caret mode meant the second recorded our own `true` as "the user's setting"
  and wrote it back on the way out, and the caret then stayed on in normal mode
  forever, re-recorded by every later arm. `armCaret` is also idempotent now, so
  an unbalanced arm or disarm cannot write anything wrong. The self-test arms
  twice and disarms once.
- Unmapped keys FALL THROUGH to the normal bindings. Caret mode must not be a
  trap.
- `y` shadows the `y*` sequence prefix, yanks, and leaves — vim and
  qutebrowser both exit visual mode on yank.
- `/` needs no work to search the selection: findbar's `startFind` calls
  `finder.getInitialSelection()`, gated on
  `accessibility.typeaheadfind.prefillwithselection`, which defaults true.
- Gecko has NO command for `e` (end of word), `V` (line selection), or
  qutebrowser's four `[` `]` block motions — only the paragraph pair. Those
  need hand-written content JS, which is why they are absent. `o`
  (selection-reverse) is content JS already: swap anchor and focus with
  `setBaseAndExtent`.
- Ctrl+C is NOT bound. It goes through `passThrough()` in child.js to Firefox's
  own key_copy, so nothing of ours has to know about the selection.

## The MODES table

Every "does X happen in this mode" question is answered from one table in
`window.js`, not from `mode === "..."` scattered across the file. Columns:

| | |
|---|---|
| `keys` | our keyset is live — AND the layout fallback runs |
| `escape` | we own Escape unconditionally (pending combo / count also claim it) |
| `swallow` | content kills every key not explicitly passed |
| `sticky` | focus changes and TabSelect must NOT move us out |
| `holdFocus` | focus changes must not move us out, but TabSelect and a page load still do. `caret` and `insert` both have it |
| `exit` | Shift-Escape is armed as the way out |

`keys` deliberately drives BOTH the keyset and the fallback: they must cover
exactly the same modes, or a punctuation binding works in one mode and is dead
in another. That was a real bug — see the layout fallback section.

`swallow` is broadcast to content rather than recomputed there. Content keeping
its own copy of which modes swallow is how the two drift apart.

The self-test walks the table: every mode needs a chip colour, and any mode
with `keys` must be covered by the fallback. Adding a mode and wiring only half
of it fails the test.

## Escape schedule

| state | owner |
|---|---|
| normal, no pending | page (modals work) |
| caret | us, drop the selection and leave |
| normal, pending combo | us, cancel only, don't touch focus |
| insert | us, exit + blur. The only KEY that leaves insert |
| command | palette's own handler |
| passthrough | page. Exit = Shift-Escape only |

Escape is NOT in `keys` (the insert-disable list). Disabling the key that
leaves insert strands you.

## Scrolling

**A scroll command only reaches the page if the page has FOCUS.** `goDoCommand`
resolves through `document.commandDispatcher`, which walks the focus ring, so
with focus parked anywhere in the chrome every scroll key is a silent no-op —
that is the "I have to click the page first" bug. Our own omnibar is the worst
offender: after `o` loads a URL, focus sits in the chrome with no element at
all, so the mode is right and the keyset is live and nothing scrolls.

`resetForNewDocument()` therefore ends in a deferred focus steal-back, for a
load as well as a tab switch. Deferred because Firefox focuses the urlbar for
`about:newtab` AFTER `TabSelect`, so a synchronous `focus()` is overridden.

**Focus in content decides WHICH scroller moves, not just whether one does.**
`PresShell::GetScrollableFrameToScrollForContent` walks UP from the focused
element and falls back to the ROOT scroller — so on a page whose root does not
scroll (classic SharePoint: `<body>` is `overflow: hidden` and `#s4-workspace`
is the real scroller) every scroll command moves the one thing that cannot,
silently. `child.js` handles it on `pageshow`: if the root cannot scroll, find
the element that can and focus it, `tabIndex = -1` if it needs one. Scrolling
stays in the PARENT, which is what makes it survive a hung content process.

Scrollability is tested by MOVING the element a pixel and putting it back, both
directions — Vimium's `doesScroll`. CSS overflow rules are too easy to read
wrong, and an element already at the bottom will not take a positive delta. The
search is breadth-first over children at least half the viewport tall, because
reading `scrollTop` forces a reflow and probing every node on a big page is slow.

qutebrowser has NO answer for this: its hjkl are synthesized arrow keys, so it
inherits the same routing, and its JS path (`javascript/scroll.js`) is
`window.scrollBy`, root-only. Vimium solves it by scrolling the element from
content (`content_scripts/scroller.js`).

`test-scroller.html` is a repro. **The self-test cannot see this** — every
assertion runs in the parent and this lives in `child.js`, which has no coverage
at all. Verify by hand: `./run.sh file://.../test-scroller.html`, press `j`.

**Do not test "can the page scroll" by asking the dispatcher for the
controller.** It falls back to the CHROME window's own scroll controller and
answers yes with a text field focused — a controller that scrolls nothing. The
gate reads `document.activeElement === gBrowser.selectedBrowser` instead: a
focused remote `<browser>` is the chrome document's activeElement.
`selectedBrowser.controllers` is empty, so there is nothing to ask directly
either. The self-test asserts the dispatcher trap itself, so it cannot be
reintroduced.

Every scroll is a Gecko command through `goDoCommand`, `hjkl` included.
**`cmd_scrollLeft` and `cmd_scrollRight` DO exist** — this file claimed they did
not, and h/l were content code (`content.scrollBy`) as a result, which scrolls
only the top-level window's ROOT scroller: a wide table or a code block inside a
div never moved, and the message never reached an iframe at all. Verify the set
with `strings /usr/lib/firefox/libxul.so | grep '^cmd_scroll'`, the same way the
caret commands are verified.

The command dispatcher routes to whatever scroller has focus, which is the whole
reason j/k worked everywhere while h/l did not. The self-test asserts a
controller exists for each of the eight names — a wrong one is swallowed by
`scrollCmd`'s catch and the key just does nothing.

qutebrowser reaches the same place from the other end: `h`/`j`/`k`/`l` are bound
to `scroll left|down|up|right` (`configdata.yml`), and on the QtWebEngine
backend `WebEngineScroller` implements those as synthesized arrow-key presses
(`_repeated_key_press(Qt.Key.Key_Left, count)` in `webenginetab.py`). Same
outcome — the engine's own scroll routing decides what moves — by a different
mechanism, because Qt gives it no command dispatcher to talk to.

## Normal mode swallows everything

Content kills keydown/keypress/keyup. Mode is broadcast; new frames send
`VimFox:Ready` to ask.

`passThrough()` in `child.js` is the allowlist. Two separate reasons for it:

- Arrows/space/PageUp/Down: we bind none of them, so scrolling is the page's
  own default action. Swallowing them just meant nothing scrolled.
- F-keys and Ctrl+Shift chords: these are FIREFOX's keys and, unlike ours, are
  NOT `reserved` — a non-reserved chrome key is processed AFTER content, so a
  `preventDefault` in the frame script kills it outright. That is why F12 and
  Ctrl+Shift+C did nothing in normal mode.

## The layout fallback

XUL matches key+modifiers strictly against the character the LAYOUT produces,
and `SHIFTED` is guesswork about which physical key carries `:` or `$`. On a
Norwegian keyboard the `$` guess is wrong (it is AltGr+4, not Shift+4) and `g$`
never fired.

Rather than keep adding candidates, the window keydown capture listener notices
when the keyset produced nothing and dispatches. It is a FALLBACK, never the
primary path — the keyset is `reserved` and beats a hung content process, which
is the whole reason the project exists. Dedup is a token: the capture listener
bumps `keyToken`, `dispatch()` stamps `keyHandledToken`, and a `setTimeout(0)`
runs only if the stamp never arrived (the XUL key handler is in the system
group, so it fires after the capture listener but before the timeout).

Escape and Shift-Escape are excluded on purpose: their XUL keys are disabled
most of the time BY DESIGN, and a fallback would undo exactly that.

`FALLBACK_MODES` is the mode gate, and every mode that runs bindings has to be
in it. Gating on `"normal"` alone left `$`, `{` and `}` dead in CARET mode —
AltGr keys the keyset never matches — while `g$` worked, because that is normal
mode. A binding that works in one mode and not another is this gate.

`fallbackWants()` is the KEY gate, and it is deliberately wider than
`isBound()`: `|| pending || count`. **An unknown key has to be able to cancel a
half-typed combo**, and an unknown key is by definition bound to nothing — so
the keyset registered no `<key>` for it, `isBound()` said no, the fallback
skipped it, and the key never reached `dispatch()` at all. `yf` then sat pending
until `COMBO_TIMEOUT`. vim, Vimium and qutebrowser
(`basekeyparser.py`, `MatchType.none` → `clear_keystring()`) all throw the
sequence away on the first key that does not continue it, and none of them
re-interpret that key as a fresh binding.

`dispatch()` handles the other half: an unmatched key throws away a half-typed
COUNT as well, or the `3` in `3f` survives onto whatever you press next — and
`x` is destructive. Both halves fail their own self-test check; they are
separate bugs that look identical.

## Omnibar

Ported from Vimium 2.4.2. Do not approximate it — read the source in the xpi.

- Ranking = `ranking.js` `wordRelevancy` + `recencyScore`. Per-field, length
  normalised, `urlScore = max(url,title)`. Recency lifts weak, never demotes.
- Domain completer = SEPARATE completer, fixed `relevancy: 2.0`, single-word
  queries only, returns ONE result. That constant is what puts raider.io over
  a page titled "raid". It is NOT in ranking.js.
- SQL is a CANDIDATE FILTER ONLY. 10x limit by frecency, then score. Ranking
  a truncated list just reproduces frecency.
- `moz_origins` is already a domain table (`prefix || host`).
- `moz_places.last_visit_date` is MICROSECONDS.
- Row layout = `top-half[source+title]` / `bottom-half[url]`. Source sits by
  the TITLE. Read `Suggestion.generateHtml`, don't infer from CSS.
- Selection starts at **-1** (`initialSelectionValue`) for open/ex. Enter with
  -1 uses raw input. Wrap past end returns to -1, not 0.
- NO debounce. NEVER clear the list. Render once, on results. Clearing first
  is what caused the blink.
- Stale replies dropped by token.

`vomnibar.css` is verbatim Vimium except two scoped selectors (`ul`,
`.no-insert-text`) — unscoped they style the whole browser UI. Positioning
overrides live in `window.js`, not that file.

## Bottom address bar / vertical tabs

- `<body>` in browser.xhtml is `display:flex; flex-direction:column`, with
  `#navigator-toolbox` and `#browser` as plain siblings. `order: 1` on the
  toolbox is the ENTIRE bottom-bar change. No reparenting. It currently ships
  COMMENTED OUT in `src/ui.js` — the address bar is at the top. Uncomment to
  move it; nothing else needs to change, because `updateChromeInset()` measures
  which edge the toolbox occupies instead of assuming.
- Vertical tabs are Firefox's own: `sidebar.revamp` + `sidebar.verticalTabs`.
  `sidebar.visibility` must ALSO be `always-show` — the profile had it at
  `hide-sidebar`, which leaves the strip on but invisible, and looks exactly
  like the prefs not applying.
- No `userChrome.css`. window.js already injects a stylesheet, so
  `toolkit.legacyUserProfileCustomizations.stylesheets` is not needed.
- which-key and toasts sit at the bottom edge, which the toolbox now occupies.
  They read `--vimfox-chrome-bottom`, fed by a ResizeObserver on the toolbox —
  a constant would be wrong in fullscreen and when the bookmarks bar toggles.

## The one urlbar internal we do depend on

The mode chip is appended to `#urlbar .urlbar-input-container`, next to
Firefox's own `#urlbar-search-mode-indicator`. That is a real dependency on the
least stable API in the browser, taken deliberately because nothing else makes
it look native. Contained by:

- If the row is missing, the chip sets `[detached]` and goes back to a fixed
  corner badge. Degrades, never vanishes.
- The self-test FAILS on the detached path, so the fallback cannot rot silently.

`moz-urlbar` builds `.urlbar-input-container` in `connectedCallback`, and
`#populateSlots` MOVES `[urlbar-slot]` children into place then deletes the
slot elements — slots are construction-time only, useless to us. window.js runs
on the window `load` event, so the row already exists; no retry needed.

## CSS traps in the injected stylesheet

- It lives in a JS TEMPLATE LITERAL. A backtick in a CSS comment ends the
  string and window.js dies with `SyntaxError: unexpected token`, which looks
  exactly like vimfox not being installed. `node --check window.js` catches it
  in a second.
- `light-dark()` nested inside `color-mix()` computes to TRANSPARENT. Use plain
  hex under a `prefers-color-scheme` media query. The failure is silent: the
  chip's own `color` kept working while the toolbar tint vanished.
- A `var()` in `color-mix()`'s percentage slot also resolved to 0%. Literal.
- `getComputedStyle` mid-transition returns the value being animated FROM. The
  self-test sets `transition: none` before measuring the tint, or it asserts
  the previous mode's colour.

## Module seams

`loadSubScript(url, {})` gives a module the CHROME WINDOW as its global, never
window.js's closure. A helper window.js forgot to pass therefore resolves to
`undefined` and throws ReferenceError at CALL time — swallowed by `run()`'s
catch into a `dump()` nobody reads. `chromeField` and `focusedFindbar` shipped
that way and killed Ctrl+W and `n`/`N`.

Every context object is wrapped in `strict()` in window.js — a Proxy whose
`get` throws on a key that is not there. The destructure at the top of each
module therefore fails at LOAD time, naming the key, instead of resolving to
`undefined` and blowing up at call time. Only the keys a module destructures
are read, so the lazy `vf.toast` / `vf.SEQUENCES` reads stay lazy. Adding a
key to a module's destructure without adding it to the context in window.js is
now a startup error, not a dead binding.

`typeof cmds[x] === "function"` does NOT catch this: it is true of a command
whose body throws. The self-test therefore CALLS every command that is safe to
run headlessly and fails on a throw. Keep `UNSAFE_TO_CALL` honest — anything
that navigates, opens a window, or writes the clipboard belongs in it, and
everything else must survive being invoked.

## What the self-test cannot see

It runs in a live window and catches a lot, but three classes have bitten:

- **A call that happens but does nothing.** `moveTabTo` grew an options object
  and a bare index became a silent no-op. Assert the EFFECT (`_tPos` moved), not
  that the call was made.
- **A command whose body throws.** `typeof cmds[x] === "function"` is true of a
  broken command. The suite now CALLS everything safe to run headlessly; keep
  `UNSAFE_TO_CALL` honest or the hole reopens.
- **An assertion that tests the bookkeeping instead of the thing.** The caret
  pref check read `caretPrefWas === null` and passed on a profile where the pref
  was leaked to `true`. Assert the pref, the attribute, the DOM.

Whenever you fix a bug, put the bug BACK once and watch the new check fail.
Every check added since the audit was verified that way.

## Self-test

`VIMFOX_SELFTEST=1 ./run.sh about:blank` → `SELFTEST PASSED` on stdout.

Checks wiring and pure logic. Cannot check key DELIVERY. Add a case for every
new binding and every bug fixed. It has caught real bugs (deleteWord on
selection, trailing-whitespace regex).

## Launching

Popup windows (OAuth logins, "open in new window") are `browser.xhtml` too, so
`attach()` skips them: `!win.toolbar.visible`, Firefox's own popup test. The
frame script defaults to not swallowing, so skipping is all it takes. Note
`openDialog` with the `all` feature re-enables every chrome flag and produces a
window that is NOT a popup by this test — verify with the feature string
Firefox actually uses for popups, and check `chromehidden` on the
documentElement. The self-test only asserts `toolbar.visible` is true in a real
window, which guards the dangerous direction; the popup half is manual.

Which monitor the window opens on is the compositor's call — Wayland gives a
client no say, and `run.sh` cannot do it. The niri rule matching
`app-id="vimfox"` in `~/.config/niri/rules.kdl` carries `open-on-output`, which
is the whole reason for the `app_id` below.

`run.sh` sets `MOZ_APP_REMOTINGNAME=vimfox`, which is what gives the window a
Wayland `app_id` of `vimfox` instead of `firefox` — so a compositor rule can
target this instance without also matching the default-profile Firefox.
Firefox's own `--class` is X11-only. There is no Firefox flag for window size
(`--window-size` is screenshot-only); the persisted size lives in the profile's
`xulstore.json` and a tiling compositor overrides it anyway.

## Dev loop

```sh
node --check window.js src/*.js child.js boot.js   # FIRST. One second, and it
                                                  # catches the backtick-in-CSS
                                                  # trap that kills the loader.
pgrep -f "[f]irefox --profile /home/thomal/.vimfox"   # [f] avoids self-match
kill <pid>; sleep 3; rm -f vimfox.log
VIMFOX_SELFTEST=1 nohup ./run.sh <url> > vimfox.log 2>&1 &
sleep 22; grep -E "SELFTEST" vimfox.log
```

`pkill -f` matches your own shell. Don't. `sleep 22` because the self-test runs
on window load and a cold profile is slow; 15 sometimes reads an empty log.

Grep for `SELFTEST`, but read the whole log when something is off — a command
that throws is logged by `run()`'s catch as `<name> failed: ...` and nothing
else surfaces it. `findNext failed: ReferenceError` sat in the log for days.

Startup on a page with text, not `about:blank`: several checks need a real
document, and `about:blank` opens with the urlbar focused, which changes what
`chromeInputFocused()` reports.

## Mouse

vimfox blocks NO mouse events, in any mode. `child.js` swallows keys only;
`mousedown` is listened to for the gesture timestamp and never cancelled. If a
click stops working, it is not the mode machine.

The one thing in this repo that touches clicks is the pinned-tab middle-click
patch in `autoconfig.cfg`, which WRAPS Firefox's own `tabs` `on_click`.
Anything thrown in that wrapper takes the built-in handler down with it and
kills middle-click-to-close on every tab, so it uses no ambient globals
(`Event` is not defined in the AutoConfig scope — read `BUBBLING_PHASE` off the
event instance) and is wrapped in try/catch.

`handleEvent` looks up `this["on_" + type]` at dispatch time, so reassigning
`on_click` does take effect.

Two things that cost real time here:

- `system/` is only a SOURCE copy. Editing `autoconfig.cfg` in the repo changes
  nothing until `sudo system/install.sh` runs. Testing an autoconfig change
  without reinstalling measures the OLD file.
- `_pinnedMclickPatched` reads false during the self-test, which runs before
  the patch's own `load` listener. That is a timing artifact, NOT evidence the
  patch is missing — it misled a whole diagnosis. Do not conclude from it.

## tabbrowser API drift

`gBrowser.moveTabTo(tab, index)` became `moveTabTo(tab, { tabIndex })` in
FF152. A bare number destructures to `undefined` and the call is a SILENT
no-op — no throw, no log, the tab just does not move. Assume any other
`gBrowser` call can go the same way, and prefer a self-test that observes the
effect over one that only checks the call happened.

`discardBrowser(tab, force)` needs `force = true` — what Firefox's own "Unload
tab" passes. Without it the browser IS discarded but never gets the
`[discarded]` attribute, so the tab still looks loaded and the thing reads as
broken; it also refuses outright if the tab has an open dialog. It is always a
no-op on the SELECTED tab (`_mayDiscardBrowser` bails on `aTab.selected`).

## Fragile

- `apt upgrade` wipes `system/` files. Re-run `system/install.sh`.
- Mozilla intends to remove `sandbox_enabled`. Then: ESR or nothing.
- Paths hardcoded to `/home/thomal`.
- Urlbar internals are the least stable API in Firefox. FF152 already replaced
  it (`moz-urlbar` custom element + `SmartbarInput.mjs`). One dependency is
  taken on purpose — see "The one urlbar internal we do depend on". Add no
  more. In particular the results panel positions itself by an INLINE
  `style.top` recomputed in `UrlbarInput.#updateTextboxPosition()` on every
  open/resize/fullscreen change: do not try to host the omnibar in it.
