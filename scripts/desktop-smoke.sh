#!/usr/bin/env bash
# Smoke-test the real desktop build without a display (cloud sessions, CI).
# Starts the release binary under Xvfb with a throwaway HOME, imports the
# sample vault, writes a file from outside (watcher), launches a second
# process (must just focus the first), checks typing is saved when the window
# closes, checks the git backup on close (vault repo -> bare remote), and
# takes screenshots.
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
  # the vault is a git repo whose origin is a local bare repo (stands in for GitHub)
  mkdir -p "$HOME/Brain"
  git init -q -b main "$HOME/Brain"
  git init -q --bare "$OUT/remote.git"
  git -C "$HOME/Brain" remote add origin "$OUT/remote.git"
  git config --global user.name "Smoke Test"; git config --global user.email smoke@example.invalid
  "$BIN" > "$OUT/app.log" 2>&1 &
  local app=$!
  sleep 10
  import -window root "$OUT/1-first-run.png"
  xdotool search --name "Artificial Brain" windowactivate --sync 2>/dev/null || true
  # the empty state's "Import sample data" button, centre of a 1400x900 window
  xdotool mousemove 660 470 click 1
  sleep 5
  import -window root "$OUT/2-sample.png"
  echo "notes on disk: $(find "$HOME/Brain" -name '*.md' -not -path '*/.*' | wc -l), folders: $(find "$HOME/Brain" -mindepth 1 -type d -not -path '*/.*' | wc -l)"
  printf -- "---\ntags: [docker]\n---\nWritten outside the app. See [[Docker]].\n" > "$HOME/Brain/Coding Club/Outside edit.md"
  sleep 3
  import -window root "$OUT/3-watcher.png"
  timeout 10 "$BIN" > /dev/null 2>&1 && echo "second launch: exited (focused the first)" || echo "second launch: did not exit"
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
  if grep -q "typed right" "$HOME/Brain/Close test.md" 2>/dev/null; then
    echo "close flush: ok ($(tail -1 "$HOME/Brain/Close test.md"))"
  else
    echo "close flush: FAILED"; ls "$HOME/Brain"; cat "$HOME/Brain/Close test.md" 2>/dev/null || true
  fi
  kill "$app" 2>/dev/null || true
  # the app commits and pushes on close
  if git --git-dir="$OUT/remote.git" log -1 --format=%s main 2>/dev/null | grep -q "Vault backup"; then
    echo "git backup: ok ($(git --git-dir="$OUT/remote.git" log -1 --format=%s main), $(git --git-dir="$OUT/remote.git" ls-tree -r --name-only main | grep -c '\.md$') notes on the remote)"
  else
    echo "git backup: FAILED"; grep -i backup "$OUT/app.log" || true
  fi
}

Xvfb :97 -screen 0 1400x900x24 > /dev/null 2>&1 &
XVFB=$!
trap 'kill $XVFB 2>/dev/null || true' EXIT
sleep 1
export -f run; export OUT BIN ROOT
dbus-run-session -- bash -c run 2> "$OUT/dbus.log"
echo "screenshots in $OUT"
