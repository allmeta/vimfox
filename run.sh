#!/bin/sh
# Launch the vimfox profile alongside your normal browser.
# --no-remote is what lets both run at once.
#
# Firefox or LibreWolf, whichever is installed; Firefox wins if both are.
# VIMFOX_BROWSER=/path/to/binary picks one explicitly. Whichever it is needs
# system/install.sh run against ITS install directory, or nothing loads.
#
# MOZ_APP_REMOTINGNAME is what sets the Wayland app_id (and the X11 WM_CLASS),
# so this window shows up as "vimfox" instead of "firefox" and a compositor
# rule can target it without also matching your default-profile Firefox.
# Firefox's own --class is X11-only and does nothing under Wayland. The env var
# also renames the remoting service, which --no-remote already opts out of.
#
# Which monitor it opens on is the compositor's call, not ours — Wayland gives a
# client no say. The niri rule matching app-id="vimfox" carries open-on-output.
DIR=$(cd "$(dirname "$0")" && pwd)

BROWSER=$VIMFOX_BROWSER
if [ -z "$BROWSER" ]; then
  for b in /usr/lib/firefox/firefox /usr/lib/librewolf/librewolf; do
    [ -x "$b" ] && BROWSER=$b && break
  done
fi
if [ -z "$BROWSER" ]; then
  echo "run.sh: no Firefox or LibreWolf found; set VIMFOX_BROWSER" >&2
  exit 1
fi

MOZ_APP_REMOTINGNAME=vimfox \
exec "$BROWSER" \
  --profile "$DIR/profile" \
  --no-remote \
  "$@"
