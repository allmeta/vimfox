// vimfox/src/keyset.js — the XUL <key> elements, and the war with Firefox's own.
//
// Two hard-won rules live here:
//
// 1. Bind the CHARACTER, not a guessed physical key. Gecko already translates
//    the layout: GetShortcutKeyCandidates builds candidates from
//    mAlternativeCharCodes, and candidate 0 is the character the press
//    produced. When Shift is held, candidates come ONLY from shifted char
//    codes, so `<key key="=" modifiers="shift">` can never match `+`. Letters
//    are the exception — Gecko will not ignore shift for them.
//
// 2. Ours and Firefox's move as one pair. `reserved="true"` beats CONTENT, not
//    other chrome keys, so a colliding built-in must be disabled for exactly as
//    long as ours is live. The scan runs over the keys we REGISTERED, never
//    over BINDINGS: the keycode keys (Escape, Shift+Escape) are built by hand
//    and a BINDINGS-driven scan cannot see them, which is how Shift+Escape
//    opened about:processes instead of leaving passthrough.

"use strict";

this.vimfoxKeyset = (vf) => {
  const {
    win, document, log, dispatch,
    BINDINGS, SEQUENCES, ALWAYS_ON, CARET_MOTIONS, CARET_EXTRA,
  } = vf;

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

  return (() => {
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

    // Ours and its built-in twins move in opposite directions, but NOT at the
    // same time. Suppressing is immediate. Releasing waits a tick: ours are
    // `reserved` and run before content, Firefox's are not and run after, so
    // both passes see the same keydown — releasing synchronously gave the very
    // key that changed mode to the built-in as well, and Ctrl+V pasted on its
    // way into passthrough. The flush recomputes from the live `disabled` state,
    // so repeated changes in one tick settle instead of racing.
    let syncQueued = false;

    const flushBuiltins = () => {
      syncQueued = false;
      for (const [ours, twins] of builtins) {
        const off = !ours.hasAttribute("disabled");
        for (const k of twins) setDisabled(k, off);
      }
    };

    const enable = (ours, on) => {
      setDisabled(ours, !on);
      if (on) {
        for (const k of builtins.get(ours) ?? []) setDisabled(k, true);
        return;
      }
      if (syncQueued) return;
      syncQueued = true;
      win.setTimeout(flushBuiltins, 0);
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
      // The self-test pairs keys with this too. It used to reimplement the
      // comparison and drifted: its version required accel but never checked
      // alt was absent, so FF155's Ctrl+Alt+U read as a clash with our Ctrl+U.
      chordOf,
      // For the self-test: releases are deferred, so asserting one needs the
      // pending pass settled first.
      flushBuiltins,
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
};
