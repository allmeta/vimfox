// vimfox/src/pinned.js — a pinned tab remembers the URL it was pinned at.
// Middle-click and a browser restart put it back there.
"use strict";

this.vimfoxPinned = function ({
  win, document, gBrowser, SessionStore, HTML, log,
}) {
  const { E10SUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/E10SUtils.sys.mjs"
  );
  // A SessionStore custom value, so it survives a restart with the tab.
  const KEY = "vimfoxPinnedUrl";

  // Session state, not currentURI: an unloaded tab has no live browser.
  const stateOf = (tab) => JSON.parse(SessionStore.getTabState(tab));
  const urlOf = (state) =>
    state.entries[(state.index || state.entries.length) - 1]?.url;

  function pin(tab) {
    const url = urlOf(stateOf(tab));
    if (url) SessionStore.setCustomTabValue(tab, KEY, url);
  }

  // A tab pinned before this existed has no value; its current URL becomes it.
  function pinnedUrl(tab) {
    if (!SessionStore.getCustomTabValue(tab, KEY)) pin(tab);
    return SessionStore.getCustomTabValue(tab, KEY);
  }

  // setTabState on the selected tab loads it; on any other tab, discarded
  // first, it stays unloaded until selected. Either way the history goes.
  // restoreTab re-applies `pinned` and `extData` from the state, which is why
  // this starts from getTabState rather than a bare entries object.
  function reset(tab) {
    const url = pinnedUrl(tab);
    if (!url) return;
    gBrowser.discardBrowser(tab, true); // no-op on the selected tab
    const state = stateOf(tab);
    delete state.scroll;
    delete state.formdata;
    delete state.userTypedValue;
    state.entries = [
      { url, triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL },
    ];
    state.index = 1;
    SessionStore.setTabState(tab, state);
  }

  // Capture on the container, so Firefox's bubbling on_click, which closes
  // the tab, never sees it.
  const onClick = (e) => {
    if (e.button !== 1) return;
    const tab = e.target.closest?.("tab");
    if (!tab?.pinned) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      reset(tab);
    } catch (ex) {
      log(`pinned reset failed: ${ex}`);
    }
  };

  // --- tint ---------------------------------------------------------------
  // Several tabs pinned to the same site have the SAME favicon, so the icon
  // alone cannot tell them apart. A per-tab colour can. Stored next to the
  // pinned URL and restored the same way.
  const TINT = "vimfoxTint";

  // The colour rides on the tab as a CSS variable; the stylesheet in ui.js
  // decides what to paint with it. A filter cannot recolour a favicon to an
  // arbitrary colour, so it is a chip behind the icon, not the icon itself.
  function applyTint(tab) {
    const color = SessionStore.getCustomTabValue(tab, TINT);
    if (color) {
      tab.style.setProperty("--vimfox-tint", color);
      tab.setAttribute("vimfox-tint", "");
    } else {
      tab.style.removeProperty("--vimfox-tint");
      tab.removeAttribute("vimfox-tint");
    }
  }

  function setTint(tab, color) {
    if (color) SessionStore.setCustomTabValue(tab, TINT, color);
    else SessionStore.deleteCustomTabValue(tab, TINT);
    applyTint(tab);
  }

  // Firefox's own colour picker: an HTML input in the chrome document. A
  // menuitem's command event is user activation, so showPicker is allowed.
  const picker = document.createElementNS(HTML, "input");
  picker.type = "color";
  picker.id = "vimfox-tint-picker";
  picker.hidden = true;
  document.documentElement.append(picker);
  let pickerTab = null;
  // `input` rather than `change`, so dragging around the picker previews live.
  const onPick = () => pickerTab && setTint(pickerTab, picker.value);
  picker.addEventListener("input", onPick);

  function pickTint(tab) {
    if (!tab) return;
    pickerTab = tab;
    picker.value = SessionStore.getCustomTabValue(tab, TINT) || "#2b6cb0";
    try {
      picker.showPicker();
    } catch (ex) {
      // showPicker is the documented path but needs activation it may not see
      // through the menu; a plain click opens the same dialog.
      log(`tint showPicker failed (${ex}); clicking instead`);
      picker.click();
    }
  }

  // Session restore sets extData BEFORE it calls pinTab, so a restored tab
  // already has its value here and is not overwritten.
  const onPinned = (e) => {
    if (!SessionStore.getCustomTabValue(e.target, KEY)) pin(e.target);
    applyTint(e.target);
  };
  const onUnpinned = (e) => {
    SessionStore.deleteCustomTabValue(e.target, KEY);
    setTint(e.target, null);
  };

  const menu = document.getElementById("tabContextMenu");
  const items = [
    ["vimfox-repin", "Re-pin URL", () => pin(win.TabContextMenu.contextTab)],
    ["vimfox-tint", "Tint…", () => pickTint(win.TabContextMenu.contextTab)],
    ["vimfox-tint-clear", "Clear tint", () =>
      setTint(win.TabContextMenu.contextTab, null)],
  ].map(([id, label, run]) => {
    const el = document.createXULElement("menuitem");
    el.id = id;
    el.setAttribute("label", label);
    el.addEventListener("command", run);
    return el;
  });
  document.getElementById("context_unpinTab").after(...items);
  // Submenus bubble their own popupshowing up through this one.
  const onMenu = (e) => {
    if (e.target !== menu) return;
    const tab = win.TabContextMenu.contextTab;
    for (const el of items) el.hidden = !tab?.pinned;
    // Nothing to clear is nothing to offer.
    if (tab?.pinned) {
      document.getElementById("vimfox-tint-clear").hidden =
        !SessionStore.getCustomTabValue(tab, TINT);
    }
  };

  // Fires once per process, after the startup restore, so a window opened
  // later never resets anything.
  let observing = true;
  const onRestored = () => {
    Services.obs.removeObserver(onRestored, "sessionstore-windows-restored");
    observing = false;
    for (const tab of gBrowser.tabs) {
      if (!tab.pinned) continue;
      try {
        applyTint(tab);
        if (urlOf(stateOf(tab)) !== pinnedUrl(tab)) reset(tab);
      } catch (ex) {
        log(`pinned startup reset failed: ${ex}`);
      }
    }
  };

  gBrowser.tabContainer.addEventListener("click", onClick, true);
  gBrowser.tabContainer.addEventListener("TabPinned", onPinned);
  gBrowser.tabContainer.addEventListener("TabUnpinned", onUnpinned);
  menu.addEventListener("popupshowing", onMenu);
  Services.obs.addObserver(onRestored, "sessionstore-windows-restored");

  return {
    KEY, TINT, pin, pinnedUrl, reset, setTint, applyTint,
    destroy() {
      picker.removeEventListener("input", onPick);
      picker.remove();
      for (const el of items) el.remove();
      gBrowser.tabContainer.removeEventListener("click", onClick, true);
      gBrowser.tabContainer.removeEventListener("TabPinned", onPinned);
      gBrowser.tabContainer.removeEventListener("TabUnpinned", onUnpinned);
      menu.removeEventListener("popupshowing", onMenu);
      if (observing) {
        Services.obs.removeObserver(onRestored, "sessionstore-windows-restored");
      }
    },
  };
};
