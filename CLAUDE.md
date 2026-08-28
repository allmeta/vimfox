# CLAUDE.md — vimfox domain knowledge

Hard-won facts. Most were bugs first. Read before changing anything.

## Shape

```
autoconfig.cfg (root, /usr/lib/firefox)
  └─ boot.js            parent process, chrome privilege
       ├─ resource://vimfox/  → ~/.vimfox   (PARENT ONLY)
       ├─ child.js  read by parent, shipped to content as data: URI
       └─ window.js loaded per browser.xhtml window
```

Mode lives in the parent. Parent is authoritative. Content only reports focus.

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
  ours on means theirs off, always. Bare unmodified characters are skipped —
  nothing built-in binds a plain letter.
- Initial state is set explicitly when the keyset is built. `setMode()` returns
  early when the mode is unchanged, so a window opening in normal mode never
  calls the setters, and anything left at its default stays wrong until the
  first real mode change.
- Dynamically added `<key>` needs keyset remove + re-append to register.
- **This machine is a US layout.** Every `SHIFTED` entry is US.
- Modifiers match EXACTLY, but the `key` attribute is matched against a LIST of
  shortcut-key candidates for the press: the character produced, and the
  character that physical key gives unshifted. So ONE keystroke can match TWO
  different `<key>` elements, and document order decides the winner. This is
  the whole reason the table is fragile — there is no way to say "the
  character `$`, however it is typed".
- A `SHIFTED` candidate must be the UNSHIFTED character on the same physical
  key. `?: ["/"]` is right. `?: ["+"]` was wrong and made Shift+= (US `+`)
  match both `key="=" shift` → zoom and `key="+" shift` → find; find won.
  A wrong candidate is worse than a missing one — the layout fallback covers a
  miss, nothing undoes a key firing the wrong command. The self-test enforces
  the rule: no candidate may itself be a shifted character.
- Uppercase letters need `modifiers="shift"`.

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
- `TabSelect` forces normal + defers focus steal-back. Firefox focuses the
  urlbar AFTER TabSelect, so a synchronous focus() is overridden.
- Listen to `focus` only, never `blur` — mid-blur focusedElement is null and
  the mode flaps.

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
- Caret mode sets `accessibility.browsewithcaret` and restores the previous
  value on exit. Without a caret there is nothing for the motions to move.
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

## Escape schedule

| state | owner |
|---|---|
| normal, no pending | page (modals work) |
| caret | us, drop the selection and leave |
| normal, pending combo | us, cancel only, don't touch focus |
| insert | us, exit + blur |
| command | palette's own handler |
| passthrough | page. Exit = Shift-Escape only |

Escape is NOT in `keys` (the insert-disable list). Disabling the key that
leaves insert strands you.

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
  toolbox is the ENTIRE bottom-bar change. No reparenting.
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

## Self-test

`VIMFOX_SELFTEST=1 ./run.sh about:blank` → `SELFTEST PASSED` on stdout.

Checks wiring and pure logic. Cannot check key DELIVERY. Add a case for every
new binding and every bug fixed. It has caught real bugs (deleteWord on
selection, trailing-whitespace regex).

## Dev loop

```sh
pgrep -f "[f]irefox --profile /home/thomal/.vimfox"   # [f] avoids self-match
kill <pid>; rm -f vimfox.log
VIMFOX_SELFTEST=1 nohup ./run.sh <url> > vimfox.log 2>&1 &
sleep 15; grep -E "^vimfox" vimfox.log
```

`pkill -f` matches your own shell. Don't.

Log keeps: startup checkpoints, `mode ->`, `suppressed <cmd>`. Add temporary
logging freely; strip when done.

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
