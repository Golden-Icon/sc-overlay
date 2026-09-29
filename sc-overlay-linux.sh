#!/usr/bin/env bash
# SC Overlay, native Linux launcher (community port from source — no Wine).
#
# Usage:
#   ./sc-overlay-linux.sh           start the transparent overlay canvas
#   ./sc-overlay-linux.sh server    start headless server only (browser UI)
#   ./sc-overlay-linux.sh toggle    show/hide the overlay canvas (for a
#                                   KWin custom shortcut — works while gaming)
#   ./sc-overlay-linux.sh stop      stop everything
#
# Overlay mode shows the real widget canvas (mission/BP tracker, mining
# scanner shell, unlock alerts...). Toggle with F3 once focused — note
# global hotkeys don't register on Wayland, so reach it via Alt-Tab,
# then F3, drag widgets where you want them, Alt-Tab back to the game.
# In KDE you can also pin it: right-click title bar > More Actions >
# Keep Above Others.
#
# Force X11 (XWayland) on purpose: click-through overlays don't pass
# mouse events on native Wayland, but they do as X11 windows under KWin.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$SRC/.sc-overlay.pid"
LOGFILE="$SRC/.sc-overlay.log"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export DISPLAY="${DISPLAY:-:0}"
for xa in "$XDG_RUNTIME_DIR"/xauth_*; do
  [ -f "$xa" ] && export XAUTHORITY="$xa" && break
done
export ELECTRON_OZONE_PLATFORM_HINT=x11

is_up() { curl -s -o /dev/null --max-time 2 "http://localhost:8778/api/missions"; }

case "${1:-}" in
  stop)
    [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE"
    pkill -f "[e]lectron electron/main" 2>/dev/null
    pkill -f "[t]sx src/overlay-server" 2>/dev/null
    echo "stopped"; exit 0 ;;
  server)
    cd "$SRC" && SC_BP_NO_WINDOW=1 npx tsx src/overlay-server.ts > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 40); do is_up && break; sleep 0.5; done
    is_up && echo "server up: http://localhost:8778/missions.html" \
            || { echo "start failed — see $LOGFILE"; exit 1; }
    exit 0 ;;
  toggle)
    # Signal the running overlay to show/hide. Needs the session display
    # (already set below for interactive shells).
    cd "$SRC" && npx electron electron/main.cjs --toggle-overlay > /dev/null 2>&1 &
    TPID=$!
    sleep 6
    kill "$TPID" 2>/dev/null
    echo "toggled"
    exit 0 ;;
esac

# Default: full overlay canvas. Electron hosts its own sidecar, so make
# sure no headless server is squatting on :8778 first.
if is_up && [ ! -f "$PIDFILE" ]; then
  echo "something else is on :8778 — stop it first ('stop' then retry)"
  exit 1
fi
cd "$SRC"
(setsid nohup npx electron electron/main.cjs > "$LOGFILE" 2>&1 < /dev/null & echo $! > "$PIDFILE")
echo "overlay launched (log: $LOGFILE)"
echo "reach it with Alt-Tab, toggle widgets with F3"
