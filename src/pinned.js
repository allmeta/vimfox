// vimfox/src/pinned.js — a pinned tab remembers the URL it was pinned at.
// Middle-click and a browser restart put it back there.
"use strict";

this.vimfoxPinned = function ({ win, document, gBrowser, SessionStore, log }) {
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

  // Session restore sets extData BEFORE it calls pinTab, so a restored tab
  // already has its value here and is not overwritten.
  const onPinned = (e) => {
    if (!SessionStore.getCustomTabValue(e.target, KEY)) pin(e.target);
  };
  const onUnpinned = (e) => SessionStore.deleteCustomTabValue(e.target, KEY);

  const menu = document.getElementById("tabContextMenu");
  const item = document.createXULElement("menuitem");
  item.id = "vimfox-repin";
  item.setAttribute("label", "Re-pin URL");
  item.addEventListener("command", () => pin(win.TabContextMenu.contextTab));
  document.getElementById("context_unpinTab").after(item);
  // Submenus bubble their own popupshowing up through this one.
  const onMenu = (e) => {
    if (e.target === menu) item.hidden = !win.TabContextMenu.contextTab?.pinned;
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
    KEY, pin, pinnedUrl, reset,
    destroy() {
      gBrowser.tabContainer.removeEventListener("click", onClick, true);
      gBrowser.tabContainer.removeEventListener("TabPinned", onPinned);
      gBrowser.tabContainer.removeEventListener("TabUnpinned", onUnpinned);
      menu.removeEventListener("popupshowing", onMenu);
      if (observing) {
        Services.obs.removeObserver(onRestored, "sessionstore-windows-restored");
      }
      item.remove();
    },
  };
};
