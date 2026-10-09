#!/usr/bin/env bash
# Drives the pet in a real X server with a compositor: transparency over a
# wallpaper, per-pixel click-through, tap and drag via the real cursor.
# Needs: Xvfb, xcompmgr, xdotool, ImageMagick (display/import).
# Usage: scripts/xvfb-e2e.sh <out-dir>
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:?out dir}"
mkdir -p "$OUT"
DISP=:77
ELECTRON=../../node_modules/.bin/electron
LOG="$OUT/e2e.log"

Xvfb $DISP -screen 0 1280x800x24 +extension Composite >/dev/null 2>&1 &
XVFB=$!
trap 'kill $APP $COMP $WALL $XVFB 2>/dev/null || true' EXIT
sleep 1
export DISPLAY=$DISP
# A busy "desktop" so transparency is visible in the capture.
convert -size 1280x800 gradient:'#2b5876-#4e4376' \
  -fill '#ffffff22' -draw 'rectangle 760,300 1260,780' \
  -fill white -pointsize 28 -annotate +790+360 'window behind the pet' "$OUT/wallpaper.png"
# A plain window, not the root background: xcompmgr ignores root pixmaps
# without _XROOTPMAP_ID and would paint grey.
display -immutable -geometry 1280x800+0+0 "$OUT/wallpaper.png" & WALL=$!
if [ "${NO_COMPOSITOR:-0}" = 1 ]; then COMP=; else xcompmgr -n >/dev/null 2>&1 & COMP=$!; fi
sleep 1

DESKPET_SOFTWARE_GL=1 DESKPET_FPS=30 $ELECTRON main.js --no-sandbox >"$LOG" 2>&1 &
APP=$!
for _ in $(seq 60); do grep -q '\[deskpet\] ready' "$LOG" && break; sleep 0.5; done
sleep 2

# The .bin/electron shim spawns the real binary, so match by class, not pid.
WIN=$(xdotool search --sync --onlyvisible --class electron | tail -1)
eval "$(xdotool getwindowgeometry --shell "$WIN")"
echo "window $WIN at $X,$Y ${WIDTH}x$HEIGHT" | tee -a "$OUT/e2e-steps.txt"
CX=$((X + WIDTH / 2)); CY=$((Y + HEIGHT * 55 / 100))

step() { echo "$*" | tee -a "$OUT/e2e-steps.txt"; }
last_state() { grep "\[state\] $1" "$LOG" | tail -1 || true; }

under() { eval "$(xdotool getmouselocation --shell)"; [ "$WINDOW" = "$WIN" ] && echo pet || echo "window $WINDOW (not the pet)"; }

xdotool mousemove $((X + 6)) $((Y + 6)); sleep 0.4
step "cursor on transparent corner -> $(last_state ignoreMouse || true); X pointer is over: $(under)"
xdotool mousemove $CX $CY; sleep 0.4
step "cursor on model body       -> $(last_state ignoreMouse); X pointer is over: $(under)"
import -window root "$OUT/desktop-hover.png"

xdotool click 1; sleep 0.6
import -window root "$OUT/desktop-tap.png"
step "clicked model (TapBody motion should play)"

xdotool mousedown 1; sleep 0.1
for i in $(seq 1 20); do xdotool mousemove $((CX - i * 15)) $((CY - i * 5)); sleep 0.02; done
xdotool mouseup 1; sleep 0.5
step "dragged 300px left, 100px up -> $(last_state position)"
eval "$(xdotool getwindowgeometry --shell "$WIN")"
step "window now at $X,$Y"
import -window root "$OUT/desktop-after-drag.png"

xdotool mousemove 20 20; sleep 0.4
step "cursor left window          -> $(last_state ignoreMouse)"
xdotool mousemove $((X + 6)) $((Y + 6)); sleep 0.4
step "back on transparent corner  -> $(last_state ignoreMouse); X pointer is over: $(under)"
