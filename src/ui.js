// vimfox/src/ui.js — everything vimfox draws: the mode chip inside the address
// bar, the which-key panel, the toast, and the injected stylesheet.
//
// The chip is a deliberate dependency on `#urlbar .urlbar-input-container`,
// the least stable API in Firefox, taken because nothing else looks native. It
// degrades to a corner badge if that row ever disappears, and the self-test
// fails on the degraded path so the fallback cannot rot silently.

"use strict";

this.vimfoxUI = (vf) => {
  const { win, document, HTML, log, TOAST_MS } = vf;

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
        const table = vf.SEQUENCES[prefix];
        if (!table) return;
        box.textContent = "";
        for (const [key, cmd] of Object.entries(table)) {
          const row = document.createElementNS(HTML, "div");
          const k = document.createElementNS(HTML, "b");
          k.textContent = prefix + key;
          const d = document.createElementNS(HTML, "span");
          d.textContent = vf.LABELS[cmd] ?? cmd;
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
  // The one place the mode becomes visible. On :root as well as the chip, so
  // the toolbar tint can read it without reaching into the chip.
  const paintMode = (mode) => {
    // Bare word: the vim `-- INSERT --` dashes are redundant inside a chip.
    indicator.textContent = mode;
    indicator.dataset.mode = mode;
    document.documentElement.dataset.vimfoxMode = mode;
  };

  // Paint the starting mode. setMode() returns early when the mode is
  // unchanged, so nothing else would until the first real switch.
  paintMode(vf.initialMode);

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

  return {
    indicator, chromeStyle, toast, whichKey, toolbox, toolboxObserver,
    updateChromeInset, paintMode,
  };
};
