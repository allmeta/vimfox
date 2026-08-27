#!/bin/sh
# Install the two root-owned files Firefox reads at startup.
#
# These live in /usr/lib/firefox, which belongs to the `firefox` deb package,
# so every Firefox upgrade wipes them. Re-run this after an upgrade — that is
# the reason they are tracked in this repo at all.
#
# They are copied, not symlinked: Firefox reads them as root at startup, and
# pointing that at a file under $HOME would let anything able to write there
# run privileged JS in the browser.
set -e

FF_DIR=/usr/lib/firefox
SRC=$(cd "$(dirname "$0")" && pwd)

if [ ! -d "$FF_DIR" ]; then
  echo "error: $FF_DIR not found — is Firefox installed from the deb?" >&2
  exit 1
fi

# Keep one pre-vimfox backup, never overwrite it.
sudo cp -n "$FF_DIR/autoconfig.cfg" "$FF_DIR/autoconfig.cfg.bak-vimfox" 2>/dev/null || true

sudo install -m 644 "$SRC/autoconfig.cfg" "$FF_DIR/autoconfig.cfg"
sudo install -m 644 "$SRC/autoconfig.js" "$FF_DIR/defaults/pref/autoconfig.js"

echo "installed:"
echo "  $FF_DIR/autoconfig.cfg"
echo "  $FF_DIR/defaults/pref/autoconfig.js"
echo
echo "Restart Firefox, then check the loader ran:"
echo "  ~/.vimfox/run.sh 2>&1 | grep vimfox"
