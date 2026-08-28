# vimfox

A qutebrowser-style vim layer for Firefox, running at chrome privilege via
AutoConfig. No extension, so it works on pages where a WebExtension cannot run
at all: `about:*`, `view-source:`, extension pages, and Mozilla's restricted
domains.

The reason it exists: an extension's keybindings are dead during page load and
on privileged pages. These are reserved XUL keys handled in the parent process,
so they work before the page has parsed, while its JS is pegged, and on a hung
tab — the same path `Ctrl+W` takes.

## Layout

| file | role |
|---|---|
| `boot.js` | AutoConfig entry point: `resource://vimfox/`, frame script, per-window hookup |
| `window.js` | parent process — modes, keyset, command palette, commands, ranking, self-test |
| `child.js` | frame script — focus reporting, key swallowing, `gi`, horizontal scroll |
| `vomnibar.css` | Vimium 2.4.2 `vomnibar_page.css`, verbatim bar two scoping fixes (see header) |
| `run.sh` | launcher (`--no-remote`, so it runs alongside your normal Firefox) |
| `test.html` | manual test page for `gi` and scrolling |
| `system/` | the two root-owned files, and their installer |

## Install

```sh
system/install.sh     # needs sudo; re-run after every Firefox upgrade
./run.sh
```

`/usr/lib/firefox` belongs to the `firefox` deb, so a Firefox upgrade deletes
both system files and vimfox silently stops loading. That is why they are
tracked here.

## Self-test

```sh
VIMFOX_SELFTEST=1 ./run.sh about:blank
```

Prints `SELFTEST PASSED` or the failing assertions to stdout. It checks wiring,
not key delivery: every binding resolves to a real command, mode transitions
route Escape correctly, built-in Firefox keys are suppressed in normal mode and
restored otherwise, and the pure logic (word deletion, match highlighting,
result ranking, key-name translation) behaves. Whether a keypress actually
arrives can only be confirmed by pressing it.

## How it fits together

Mode lives in the parent process and is authoritative. Normal-mode keys are
registered as `<key reserved="true">`, which Firefox matches before consulting
the content process; entering insert mode disables that keyset so typing
reaches the page.

Three things fall out of that design and are worth knowing before changing it:

- **Escape is mode-dependent.** Ours only while in insert mode or with a key
  combo pending; otherwise the page gets it, so site modals still close.
- **Built-in Firefox keys are suppressed only while ours are listening.**
  `Ctrl+D`, `Ctrl+U`, `Ctrl+V` and `Alt+N` are handed back in insert mode —
  blanket-suppressing `key_paste` would break paste in the URL bar.
- **Pages cannot pull you into insert mode.** Focus only counts if a real user
  gesture preceded it, so an autofocusing search box is ignored.

## Keymap

| | |
|---|---|
| `j` `k` | scroll down / up |
| `d` `u` | half page down / up (`C-d` / `C-u` alias) |
| `h` `l` | scroll left / right |
| `gg` `G` | top / bottom |
| `J` `K` | previous / next tab |
| `x` `X` | close tab / undo close |
| `gJ` `gK` | move tab right / left |
| `g0` `g$` | first / last tab |
| `Alt-1..8` `Alt-9` | focus tab N / last |
| `yt` `gC` | clone tab |
| `Alt-m` | mute tab |
| `H` `L` | back / forward |
| `r` | reload |
| `o` `O` | open in current / new tab |
| `ge` | edit current URL |
| `gu` `gU` | up one URL path (current / new tab) |
| `gt` | tab search |
| `b` `B` | bookmark search (current / new tab) |
| `M` | bookmark page (Ctrl+D dialog) |
| `gi` | focus inputs, Tab cycles |
| `/` `?` `n` `N` | find, next, previous |
| `yy` `yT` `yd` `yp` `ym` | copy url / title / domain / decoded / markdown |
| `pp` `Pp` | open clipboard URL (current / new tab) |
| `-` `+` `=` | zoom out / in / reset |
| `v` | caret mode (also entered by selecting text) |
| `C-c` | copy the selection, any mode |
| `i` `Esc` | insert / normal mode |
| `C-v` | passthrough (leave with `Shift-Esc`) |
| `C-w` | delete word (vim word classes, works everywhere) |
| `^` `gl` | last used tab (`^` is a dead key on some layouts) |
| `wn` `wp` | new window / new private window |
| `3j` `5J` | counts repeat a command; `Esc` throws the buffer away |
| `:` | command menu — every command listed and filtered as you type |

## Caret mode

qutebrowser's keymap, from its `bindings.default.caret`. `v` enters it, or just
select text with the mouse.

| | |
|---|---|
| `h` `l` `j` `k` | char / line |
| `w` `b` | word forward / back |
| `0` `$` | start / end of line |
| `gg` `G` | start / end of document |
| `{` `}` | paragraph back / forward |
| `v` | arm selection — motions extend it instead of moving the caret |
| `o` | swap which end of the selection the motions move |
| `y` | copy and leave |
| `/` `n` `N` | find, seeded with the selection |
| `H` `J` `K` `L` | scroll |
| `c` `Esc` | back to normal |

Counts work (`3w`). Every motion is a pair of Gecko commands — `cmd_wordNext`
and `cmd_selectWordNext` — so `v` costs one array index. `e`, `V` and
qutebrowser's `[` `]` block motions are absent: Gecko has no command for them.

## Omnibar

`o` / `O` query Places directly and rank with Vimium's algorithm, ported from
`ranking.js` and `completers.js`: per-field word relevancy with length
normalisation, recency that lifts weak matches but never demotes strong ones,
and smartcase. A domain completer contributes one result at a fixed relevancy
of 2.0, which is what puts `raider.io` above a page merely titled "raid".

SQL is only the candidate filter — it pulls 10x the display limit by frecency,
then scoring decides the order. Ranking a pre-truncated list would just
reproduce frecency ordering.

## Known gaps

- No link hints (`f`). Cross-origin iframes under Fission need parent-side hint
  allocation across processes; it is a project of its own.
- No marks, quickmarks, or `.` repeat.
- Counts just run a command N times. Right for every motion here; a command
  wanting the number itself (vim's `42G`) would have to read it instead.
- No open-tab results in the `o` omnibar, and no per-engine search keywords.
- Paths are hardcoded to `/home/thomal`.
