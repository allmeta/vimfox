// vimfox/boot.js — parent process, chrome privileges. Loaded from autoconfig.cfg.
"use strict";

(() => {
  const DIR = "/home/thomal/.vimfox";

  // `Services` is a chrome global in modern Firefox; the ESM was removed.

  // dump() reaches stdout (with browser.dom.window.dump.enabled); the console
  // service does not. During bring-up, stdout is the only channel that matters.
  const log = (m) => dump(`vimfox: ${m}\n`);
  log("boot.js running");

  // resource://vimfox/ -> ~/.vimfox, parent process only. Nothing in a content
  // process resolves this scheme, by design (see the frame script below).
  const dirFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  dirFile.initWithPath(DIR);
  Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsISubstitutingProtocolHandler)
    .setSubstitution("vimfox", Services.io.newFileURI(dirFile));
  log("resource://vimfox/ registered");

  // ---- keybindings (parent process) ------------------------------------
  // Set up FIRST and guarded on its own. This is the part that must never die:
  // it is the whole reason for the design, and it has no content-side deps.
  const windowURL = "chrome://browser/content/browser.xhtml";
  function attach(win) {
    if (win.location.href !== windowURL || win.VimFox) return;
    try {
      Services.scriptloader.loadSubScript("resource://vimfox/window.js", win);
    } catch (ex) {
      log("window.js FAILED: " + ex + "\n" + ex.stack);
    }
  }

  try {
    for (const win of Services.wm.getEnumerator("navigator:browser")) attach(win);

    Services.ww.registerNotification((subject, topic) => {
      if (topic !== "domwindowopened") return;
      subject.addEventListener("load", () => attach(subject), { once: true });
    });
  } catch (ex) {
    log("window hookup FAILED: " + ex);
  }

  // ---- content side (optional) -----------------------------------------
  // Editable-focus reporting and gi. Everything below is best-effort: if it
  // throws, the keybindings above still work. Scrolling deliberately does not
  // go through here at all — window.js uses Firefox's own scroll commands.
  //
  // NOT a JSWindowActor: an actor's child ESM is loaded by the CONTENT process,
  // whose sandbox refuses to read ~/.vimfox ("Failed to load
  // resource://vimfox/VimFoxChild.sys.mjs", once per document). A frame script
  // sidesteps it — the PARENT reads the file, which it may, and ships the
  // source inline as a data: URI so content never touches the filesystem.
  try {
    // IOUtils is not a global in the AutoConfig scope; streams are.
    const readText = (path) => {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      const stream = Cc[
        "@mozilla.org/network/file-input-stream;1"
      ].createInstance(Ci.nsIFileInputStream);
      stream.init(file, -1, 0, 0);
      const conv = Cc[
        "@mozilla.org/intl/converter-input-stream;1"
      ].createInstance(Ci.nsIConverterInputStream);
      conv.init(stream, "UTF-8", 0, 0);
      let text = "";
      const chunk = {};
      while (conv.readString(4096, chunk) !== 0) text += chunk.value;
      conv.close();
      return text;
    };

    Services.mm.loadFrameScript(
      "data:application/javascript," +
        encodeURIComponent(readText(`${DIR}/child.js`)),
      true // also load into frames created later
    );
    log("frame script loaded");

    // NB: the VimFox:Focus listener lives in window.js, on that window's own
    // message manager. Listening globally here meant resolving browser element
    // -> chrome window via ownerGlobal, which did not give back the window
    // holding the mode machine (hasVimFox=false). Per-window has the window in
    // scope already, so there is nothing to resolve.
  } catch (ex) {
    log("frame script FAILED (keys still work): " + ex);
  }
})();
