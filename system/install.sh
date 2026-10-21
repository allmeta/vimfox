#!/bin/sh
# Install the two root-owned files the browser reads at startup.
#
#   system/install.sh              every supported browser that is installed
#   system/install.sh /some/dir    just that install directory
#
# Supported: Firefox (/usr/lib/firefox) and LibreWolf (/usr/lib/librewolf).
# On LibreWolf, autoconfig.cfg takes over general.config.filename from
# librewolf.cfg and runs librewolf.cfg itself first — see the top of that file.
#
# On a deb the install directory belongs to the package, so every upgrade
# wipes these. Re-run this after an upgrade — that is the reason they are
# tracked in this repo at all.
#
# They are copied, not symlinked: the browser reads them as root at startup,
# and pointing that at a file under $HOME would let anything able to write
# there run privileged JS in the browser.
set -e

SRC=$(cd "$(dirname "$0")" && pwd)

if [ $# -gt 0 ]; then
  DIRS=$*
else
  DIRS=
  for d in /usr/lib/firefox /usr/lib/librewolf; do
    [ -d "$d" ] && DIRS="$DIRS $d"
  done
fi
if [ -z "$DIRS" ]; then
  echo "error: no Firefox or LibreWolf install found; pass its directory" >&2
  exit 1
fi

for dir in $DIRS; do
  if [ ! -d "$dir/defaults/pref" ]; then
    echo "error: $dir/defaults/pref not found — not a browser install?" >&2
    exit 1
  fi
  # Keep one pre-vimfox backup, never overwrite it.
  sudo cp -n "$dir/autoconfig.cfg" "$dir/autoconfig.cfg.bak-vimfox" 2>/dev/null || true

  sudo install -m 644 "$SRC/autoconfig.cfg" "$dir/autoconfig.cfg"
  sudo install -m 644 "$SRC/autoconfig.js" "$dir/defaults/pref/autoconfig.js"

  echo "installed:"
  echo "  $dir/autoconfig.cfg"
  echo "  $dir/defaults/pref/autoconfig.js"
done
echo
echo "Restart the browser, then check the loader ran:"
echo "  $(dirname "$SRC")/run.sh 2>&1 | grep vimfox"
