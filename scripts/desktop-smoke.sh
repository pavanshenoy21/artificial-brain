#!/usr/bin/env bash
# Smoke-test the real desktop build without a display (cloud sessions, CI).
# Starts the release binary under Xvfb with a throwaway HOME, imports the
# sample, writes a file from outside (watcher), opens quick capture through a
# second process, and takes screenshots.
#
#   sudo apt-get install -y xvfb xdotool imagemagick dbus-x11   # once
#   npx tauri build --no-bundle && scripts/desktop-smoke.sh [out-dir]
set -euo pipefail
OUT=${1:-$(mktemp -d)}
BIN=$(cd "$(dirname "$0")/.." && pwd)/src-tauri/target/release/brain
[ -x "$BIN" ] || { echo "build first: npx tauri build --no-bundle"; exit 1; }
mkdir -p "$OUT/home"

run() {
  export DISPLAY=:97 HOME="$OUT/home" WEBKIT_DISABLE_COMPOSITING_MODE=1
  "$BIN" > "$OUT/app.log" 2>&1 &
  local app=$!
  sleep 10
  import -window root "$OUT/1-first-run.png"
  xdotool search --name "Artificial Brain" windowactivate --sync 2>/dev/null || true
  # the empty state's "Import sample data" button, centre of a 1400x900 window
  xdotool mousemove 660 470 click 1
  sleep 5
  import -window root "$OUT/2-sample.png"
  echo "items on disk: $(find "$HOME/Brain" -name '*.md' -not -path '*/.*' | wc -l)"
  printf -- "---\ntags: [docker]\n---\nWritten outside the app. See [[Docker]].\n" > "$HOME/Brain/notes/Outside edit.md"
  sleep 3
  import -window root "$OUT/3-watcher.png"
  "$BIN" --capture > /dev/null 2>&1 || true
  sleep 3
  import -window root "$OUT/4-capture.png"
  kill "$app" 2>/dev/null || true
}

Xvfb :97 -screen 0 1400x900x24 > /dev/null 2>&1 &
XVFB=$!
trap 'kill $XVFB 2>/dev/null || true' EXIT
sleep 1
export -f run; export OUT BIN
dbus-run-session -- bash -c run 2> "$OUT/dbus.log"
echo "screenshots in $OUT"
