#!/bin/sh
# Launch the vimfox profile alongside your normal Firefox.
# --no-remote is what lets both run at once.
exec /usr/lib/firefox/firefox \
  --profile /home/thomal/.vimfox/profile \
  --no-remote \
  "$@"
