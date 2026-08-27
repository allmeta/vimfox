// vimfox test profile. Isolated from ~/.mozilla/firefox — nothing here touches
// your default-release profile.

// NB: general.config.sandbox_enabled canNOT be set here — AutoConfig runs
// before profile prefs are read. It lives in
// /usr/lib/firefox/defaults/pref/autoconfig.js instead.

// Let WebExtensions run on Mozilla's own domains (AMO, support.mozilla.org).
// Cheap win, independent of everything else here.
user_pref("extensions.webextensions.restrictedDomains", "");

// Browser Console + chrome debugging, so vimfox errors are visible.
// dump.enabled is what makes dump() reach stdout — without it the loader's
// catch blocks are silent and a failure looks exactly like a success.
user_pref("browser.dom.window.dump.enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.console.stdout.chrome", true);

// Quieten first-run noise in a throwaway profile.
user_pref("browser.aboutConfig.showWarning", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.newtabpage.enabled", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.aboutwelcome.enabled", false);

// Vertical tabs, Firefox's own — no code, and it frees the top edge so the
// address bar can move to the bottom (that half is one CSS rule in window.js).
// visibility must be set too: the profile had it at "hide-sidebar", which
// leaves verticalTabs on but the strip invisible.
user_pref("sidebar.revamp", true);
user_pref("sidebar.verticalTabs", true);
user_pref("sidebar.visibility", "always-show");
