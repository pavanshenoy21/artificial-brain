#!/usr/bin/env bash
# Smoke-test the real desktop build without a display (cloud sessions, CI).
# Starts the release binary under Xvfb with a throwaway HOME, imports the
# sample, writes a file from outside (watcher), opens quick capture through a
# second process, checks typing is saved when the window closes, and takes
# screenshots.
#
#   sudo apt-get install -y xvfb xdotool imagemagick dbus-x11   # once
#   pip install python-xlib                                      # once
#   npx tauri build --no-bundle && scripts/desktop-smoke.sh [out-dir]
set -euo pipefail
OUT=${1:-$(mktemp -d)}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN=$ROOT/src-tauri/target/release/brain
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
  xdotool key Escape
  sleep 1
  # type into a new note and close the window at once, well inside the 500ms
  # autosave: the close hook must still flush it to disk
  local win
  win=$(xdotool search --name "Artificial Brain" | head -1)
  xdotool windowactivate --sync "$win" 2>/dev/null || true
  xdotool key ctrl+n; sleep 1
  xdotool type --delay 20 "Close test"; xdotool key Return
  # 60ms/key so WebKit keeps up (no autosave while typing), then close 200ms later
  xdotool type --delay 60 "typed right before closing"; sleep 0.2
  python3 "$ROOT/scripts/wm-close.py" "$win" || echo "wm-close failed (pip install python-xlib)"
  for _ in 1 2 3 4 5; do kill -0 "$app" 2>/dev/null || break; sleep 1; done
  # without the flush the body is empty; the tail may be cut if keys were still queued
  if grep -q "typed right" "$HOME/Brain/notes/Close test.md" 2>/dev/null; then
    echo "close flush: ok ($(tail -1 "$HOME/Brain/notes/Close test.md"))"
  else
    echo "close flush: FAILED"; cat "$HOME/Brain/notes/Close test.md" 2>/dev/null || true
  fi
  kill "$app" 2>/dev/null || true
}

Xvfb :97 -screen 0 1400x900x24 > /dev/null 2>&1 &
XVFB=$!
trap 'kill $XVFB 2>/dev/null || true' EXIT
sleep 1
export -f run; export OUT BIN ROOT
dbus-run-session -- bash -c run 2> "$OUT/dbus.log"
echo "screenshots in $OUT"
