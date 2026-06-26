#!/usr/bin/env bash
#
# Launches Chromium in kiosk mode (full-screen, no UI).
# Register it in your desktop environment's autostart:
#   X11:            put a .desktop file in ~/.config/autostart/, or use LXDE autostart
#   Wayland (labwc): add a call to this script in ~/.config/labwc/autostart
#
# Note: if you use the remote's screen on/off (screenPower) via DPMS, fully
# disabling DPMS here (-dpms) conflicts with it. In that case, comment out the
# xset line below and manage power via the screenPower commands (see README).

set -u

URL="http://localhost:3000/"

# The Chromium binary name differs across distros.
CHROME_BIN="$(command -v chromium-browser || command -v chromium || echo chromium-browser)"

# X11-only commands (ignored on Wayland).
if command -v xset >/dev/null 2>&1; then
  xset s off          # disable the screensaver
  xset s noblank      # disable blanking
  xset -dpms          # disable power saving (DPMS) -- comment out if using screenPower
fi

# Hide the mouse cursor (X11 only).
# NOTE: unclutter is X11-only and has no effect under Wayland. On a Wayland
# (labwc) session, switch the kiosk to X11 via `sudo raspi-config`
# (Advanced Options -> Wayland -> X11), or use a transparent cursor theme.
# See README / SETUP for details.
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  echo "kiosk.sh: Wayland session detected -- unclutter cannot hide the cursor. Switch to X11 (raspi-config) to hide it." >&2
elif command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 0 -root &
fi

# Wait for the proxy to come up (~30s max).
for i in $(seq 1 30); do
  if curl -sf "${URL}api/data" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

exec "$CHROME_BIN" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --incognito \
  "$URL"
