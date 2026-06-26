# Raspberry Pi setup guide

How to get pi-calendar-display running on a Raspberry Pi so that, on power-on, it automatically shows your calendar & weather full-screen.

> **No build required.** You run `node server.js` directly (no bundling/compilation step). See [README.md](README.md) for details.

---

## 0. Prerequisites (OS install)

Have Raspberry Pi OS installed (**Desktop edition recommended**). Follow the official guide for installation.

- Raspberry Pi OS: <https://www.raspberrypi.com/software/>
- Use Raspberry Pi Imager to write "Raspberry Pi OS (64-bit)", and on first boot set the user (e.g. `pi`), Wi-Fi, and locale.

From here on, this guide assumes the user is `pi` and the install path is `/home/pi/pi-calendar-display`. Adjust to your environment.

Make sure a display is connected and the desktop (X11 or Wayland/labwc) is showing. Newer Raspberry Pi OS defaults to **Wayland (labwc)** (the autostart step below branches on this).

---

## 1. System packages

Run the following in a terminal.

```bash
sudo apt update && sudo apt full-upgrade -y
```

### 1-1. Node.js (18+, 20 LTS recommended)

**Node 18+ is required** because it uses `fetch` / `AbortSignal.timeout`. The `apt` default Node is often too old, so install from NodeSource.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # confirm v20.x or newer
npm -v
```

### 1-2. Fonts (required for non-Latin text)

Without CJK fonts, events and dates render as tofu boxes (□□).

```bash
sudo apt install -y fonts-noto-cjk
```

### 1-3. Kiosk display & utilities

```bash
# Chromium itself (chromium-browser or chromium depending on distro)
sudo apt install -y chromium-browser || sudo apt install -y chromium

# Hide the mouse cursor
sudo apt install -y unclutter

# Screen on/off control (pick the one matching your display server)
sudo apt install -y x11-xserver-utils   # X11: xset
sudo apt install -y wlr-randr           # Wayland (labwc): wlr-randr
```

> Check which display server you're on with `echo $XDG_SESSION_TYPE` (`x11` or `wayland`).

---

## 2. Clone & install

```bash
cd ~
git clone https://github.com/<your-account>/pi-calendar-display.git
cd pi-calendar-display
npm install      # express / googleapis (pure JS, no native build)
```

---

## 3. Configuration (config.json and .env)

Configuration splits into two places. **Secrets go in `.env`, structural settings in `config.json`** (recommended; `.env` takes precedence, and both are gitignored).

```bash
cp config.example.json config.json
cp .env.example .env
nano .env          # fill in Google credentials, weather coordinates, etc.
```

### Main .env entries

```ini
# Google OAuth (calendar access; issued in step 4)
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
# Only if you change the port from the default 3000, match the callback too
# GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback

# Weather (Open-Meteo; coordinates of your location)
WEATHER_LATITUDE=35.7528
WEATHER_LONGITUDE=139.7336
WEATHER_LOCATION_NAME=Tokyo Kita
WEATHER_TIMEZONE=Asia/Tokyo

# Port (default 3000; kiosk.sh also targets 3000, so change both if you change it)
# PORT=3000
```

> **The port and redirect URI must match.** If you keep the default `3000`, no extra config is needed (the callback is `http://localhost:3000/oauth2callback`). If you change `PORT`, align `GOOGLE_REDIRECT_URI`, the registered URI in Google Console, and the URL in `kiosk.sh` to the same port.

### Main config.json entries

- `calendars[]` … calendars to display. `role` is `events` (normal) or `location` (work location). Replace the placeholder (`xxxx@group.calendar.google.com`) with a real ID, or delete it.
- `weather.*` … can be left blank if overridden via `.env`.
- `display.brightness` … per-time-of-day brightness (auto-adjust, below).
- `display.view` … view modes and the auto-night window.
- `remote.screenPower` … screen on/off commands (step 8).

---

## 4. Issue a Google OAuth client

Calendar access requires an OAuth client issued with your own Google account (the maintainer cannot set this up for you).

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Under **APIs & Services → Library**, enable the **Google Calendar API**.
3. Configure the **OAuth consent screen** (User Type: External; add your own Google account as a test user).
4. **Credentials → Create OAuth client ID**; type: **Web application**.
   - Add `http://localhost:3000/oauth2callback` to the **Authorized redirect URIs** (use your port if you changed it).
5. Put the issued **Client ID / Client secret** into `.env`.

---

## 5. First sign-in (one time)

There is no sign-in button on the display. The auth flow is to **open `/auth` once in a browser**.

```bash
npm start
```

- The startup log prints the auth URL.
- Open the following **in a browser on the Pi** (if headless, temporarily attach a desktop or use SSH port forwarding):

  ```text
  http://localhost:3000/auth
  ```

- Sign in to Google → approve → `token.json` is generated automatically. From then on it **auto-refreshes via the refresh token** — no re-login needed.

> To just check it works first, run `PCD_DEMO=1 npm start` to show sample events (no OAuth; calendar fetch is skipped).

Once confirmed, stop it with `Ctrl+C`.

---

## 6. Run the proxy as a service (systemd)

Make it auto-start on power-on and auto-restart if it crashes.

```bash
# Edit paths / user for your environment
nano calendar-dashboard.service       # User / WorkingDirectory / ExecStart

sudo cp calendar-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now calendar-dashboard

systemctl status calendar-dashboard   # check it's running
journalctl -u calendar-dashboard -f   # follow logs
```

`ExecStart` runs `node server.js` directly (equivalent to `npm start`).

> To run the remote's screen on/off from this service, set the unit's environment so it reaches the kiosk session: `Environment=DISPLAY=:0` (X11) or `Environment=WAYLAND_DISPLAY=wayland-0` / `XDG_RUNTIME_DIR=/run/user/1000` (Wayland). See the comments in `calendar-dashboard.service`.

---

## 7. Autostart the kiosk (full-screen)

Register `kiosk.sh` in your desktop's autostart. The location differs by display server.

### Wayland / labwc (default on newer Raspberry Pi OS)

```bash
mkdir -p ~/.config/labwc
echo "bash $HOME/pi-calendar-display/kiosk.sh &" >> ~/.config/labwc/autostart
```

### X11 (LXDE)

```bash
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/calendar-kiosk.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Calendar Kiosk
Exec=bash /home/pi/pi-calendar-display/kiosk.sh
X-GNOME-Autostart-enabled=true
EOF
```

Reboot and confirm the full-screen display.

```bash
sudo reboot
```

`kiosk.sh` auto-detects the Chromium binary name (`chromium-browser` / `chromium`), waits for the proxy to come up, and opens `http://localhost:3000/` full-screen.

> 🖱 **Mouse cursor on Wayland:** the cursor is hidden with `unclutter`, which is **X11-only** and does nothing under Wayland (the default on newer Raspberry Pi OS). To hide it on a kiosk, switch the session to X11: `sudo raspi-config` → Advanced Options → Wayland → **X11**, then reboot. (`kiosk.sh` prints a warning when it detects a Wayland session.) To stay on Wayland, use a transparent cursor theme by exporting `XCURSOR_THEME` before the `kiosk.sh` call in your autostart.

---

## 8. Screen on/off (optional)

You can physically turn the screen off/on from the remote. Configure `config.json`'s `remote.screenPower` for your environment.

```jsonc
// X11
"screenPower": { "off": "xset dpms force off", "on": "xset dpms force on" }

// Wayland (labwc) — find the output name with `wlr-randr`
"screenPower": { "off": "wlr-randr --output HDMI-A-1 --off",
                 "on":  "wlr-randr --output HDMI-A-1 --on" }
```

> **Mind the DPMS conflict:** `kiosk.sh` runs `xset -dpms` to prevent sleep. On X11, using `screenPower` via DPMS conflicts with this — either comment out `xset -dpms` in `kiosk.sh`, or manage power via the `screenPower` commands.

---

## 9. Phone remote

Open it from a phone on the same LAN (find the Pi's IP with `hostname -I`).

```text
http://<RaspberryPi-IP>:3000/remote
```

- Switch / **upload** background images
- Switch view mode (full / timeline / week / month / night)
- **Set the auto-night window** (switch to night at a set time → revert to the previous mode at the end time)
- Adjust brightness / screen on/off / resync now

> ⚠️ The remote has no authentication. It **assumes a trusted LAN**. Do not expose it to the internet.

---

## 10. Updating

No build step, so just pull the code and restart.

```bash
cd ~/pi-calendar-display
git pull
npm install                              # if dependencies changed
sudo systemctl restart calendar-dashboard
```

Frontend-only changes (`public/`) take effect by reloading (or restarting) the kiosk.

---

## 11. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Text shows as □□ | Run `sudo apt install -y fonts-noto-cjk` and reboot |
| `node: command not found` / old Node | Install Node 20 from NodeSource (step 1-1) |
| "config.json not found" | `cp config.example.json config.json` (or configure via `.env`) |
| Auth fails / callback error | Confirm the port matches across `GOOGLE_REDIRECT_URI`, the Google Console URI, and `kiosk.sh` |
| No events | Check that you're authenticated (`token.json` exists), the `calendars` IDs and sharing, and test-user registration on the consent screen. Confirm you're not running with `PCD_DEMO=1` |
| Wrong/no weather | Check `WEATHER_LATITUDE/LONGITUDE` matches your location and network connectivity |
| Kiosk won't start | Confirm you registered the autostart in the right place for your display server (`echo $XDG_SESSION_TYPE`). Check the actual `chromium` binary name |
| Mouse cursor won't hide | `unclutter` is X11-only and does nothing on Wayland. Switch to X11 via `raspi-config` (Advanced Options → Wayland → X11), or use a transparent cursor theme |
| Screen on/off has no effect | Check the `screenPower` commands and the systemd `DISPLAY` / `WAYLAND_DISPLAY` env vars |
| Remote unreachable | Confirm phone and Pi are on the same LAN, `config.remote.enabled` is `true`, and the port matches |

---

## Appendix: trying it on a local PC

It works the same on a Mac/PC (no systemd / kiosk needed).

```bash
npm install
cp config.example.json config.json
cp .env.example .env        # optional; set weather coordinates etc.
PCD_DEMO=1 npm start        # sample events for a quick check (no OAuth)
# → http://localhost:3000/ and http://localhost:3000/remote
```
