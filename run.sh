#!/bin/sh
# Launch the vimfox profile alongside your normal Firefox.
# --no-remote is what lets both run at once.
#
# MOZ_APP_REMOTINGNAME is what sets the Wayland app_id (and the X11 WM_CLASS),
# so this window shows up as "vimfox" instead of "firefox" and a compositor
# rule can target it without also matching your default-profile Firefox.
# Firefox's own --class is X11-only and does nothing under Wayland. The env var
# also renames the remoting service, which --no-remote already opts out of.
MOZ_APP_REMOTINGNAME=vimfox \
exec /usr/lib/firefox/firefox \
  --profile /home/thomal/.vimfox/profile \
  --no-remote \
  "$@"
