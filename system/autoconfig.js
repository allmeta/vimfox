pref("general.config.filename", "autoconfig.cfg");
pref("general.config.obscure_value", 0);
// Without this, autoconfig.cfg runs in a restricted sandbox exposing only the
// AutoConfig API (pref/lockPref/getPref/...) — Components and Cc are undefined,
// so any script doing real chrome work fails with "Cc is not defined".
pref("general.config.sandbox_enabled", false);
