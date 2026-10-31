# rs3mini-bridge

HTTP → BLE bridge for the **DJI Ronin RS 3 Mini**. Run it on a small Linux host near the gimbal (e.g. **Raspberry Pi Zero 2 W**); control it over Wi‑Fi via **`curl`**, scripts, or any HTTP client. HTTP lives in the parent process; BLE/noble runs in a forked child so a hung connect cannot freeze `:8787`.

Replaces a tablet + remote-desktop + Bluetooth chain with a single **Wi‑Fi → BLE** hop.

## Features

- **State-driven d-pad** — latest direction replaces the old one; quick release gets a minimum nudge; hold streams until release; no move FIFO
- **Recenter**, **motor sleep/wake**, **telemetry**, **battery** on `GET /state`
- **Name discovery** — scans BLE ads, connects when name matches your unit suffix (`GIMBAL_NAME_RE`)
- **Status UI** at `/` and `GET /health/label` for link status
- **systemd** service for headless deploy

Tested on **Raspberry Pi Zero 2 W** (Pi OS 64-bit) with Node 20.

## Requirements

| | |
|---|---|
| **Gimbal** | DJI Ronin **RS 3 Mini**, powered on, **DJI mobile app closed** (one BLE central) |
| **Host** | Linux with Bluetooth (BlueZ); **Node.js ≥ 20** |
| **Range** | Keep the bridge **within a few feet** of the gimbal (Pi Zero antenna is weak) |
| **Network** | HTTP clients reach the bridge on your LAN (default port **8787**) |

macOS works for development; production target is **Linux on ARM** (Pi).

## Quick start (development)

```bash
git clone https://github.com/b-rutledge-code/rs3mini-bridge.git
cd rs3mini-bridge
npm ci
export GIMBAL_NAME_RE=YOURSUFFIX   # your unit suffix (gimbal LCD / DJI app)
npm start
```

Open `http://127.0.0.1:8787/` for status. With the gimbal awake nearby:

```bash
npm run scan                    # optional — list BLE devices
# Bench calibration (bridge running): see API.md + docs/GIMBAL-BLE.md
BRIDGE_URL=http://<pi>:8787 npm run calib:from-bridge
curl -X POST http://127.0.0.1:8787/move/hold -H 'Content-Type: application/json' -d '{"tilt":1}'
curl -X POST http://127.0.0.1:8787/move/stop
curl -X POST http://127.0.0.1:8787/center
```

## Install on Linux (Raspberry Pi)

1. **Site config** (gitignored) — kit IPs + gimbal suffix, applied on every install:

   ```bash
   cp site.env.example site.env
   # edit: PI_HOST, PI_USER, GIMBAL_NAME_RE, COMPANION_HOST, …
   ```

2. Copy the repo to the bridge host (no `node_modules` — build on the Pi):

   ```bash
   bash scripts/deploy.sh                              # reads site.env
   FULL_INSTALL=1 bash scripts/deploy.sh               # first install (apt + setcap)
   ```

   From the streaming repo (password sudo on Pi — keep `PI_PASSWORD` in `.local/pi-bridge.env`):

   ```bash
   python3 .local/deploy-bridge.py
   ```

   Or manually:

   ```bash
   rsync -av --exclude node_modules ./ pi@<bridge-host>:/opt/rs3mini-bridge/
   ssh pi@<bridge-host> 'bash /opt/rs3mini-bridge/scripts/install.sh'
   ```

   `install.sh` runs `scripts/apply-site-env.sh`, which merges runtime keys from **`site.env`** into **`/etc/rs3mini-bridge.env`**.

3. Verify:

   ```bash
   curl http://127.0.0.1:8787/health/label   # "OK" when BLE is up
   journalctl -u rs3mini-bridge -f
   ```

### Environment

**Kit / deploy:** **`site.env`** (from **`site.env.example`**, gitignored) — `PI_*`, `COMPANION_*`, and bridge runtime keys.  
**On-device:** **`/etc/rs3mini-bridge.env`** (from **`rs3mini-bridge.env.example`**, then overwritten by site apply). Set **`GIMBAL_NAME_RE`** to your gimbal’s unit suffix (LCD or DJI app — e.g. `YOURSUFFIX` for `DJI RS3 MINI-YOURSUFFIX`).

| Variable | Example | Notes |
|----------|---------|-------|
| `GIMBAL_NAME_RE` | `YOURSUFFIX` | **Required** — unit suffix in advertised BLE name |
| `PORT` | `8787` | HTTP listen port |
| `RECONNECT_MS` | `5000` | Background reconnect interval (`0` = off) |
| `MOVE_HOLD_MS` | `0` | Optional orphan silence → neutral (Page 3: off) |
| `HOLD_PROMOTE_MS` | `250` | Tap-vs-hold threshold |
| `NUDGE_MS` | `180` | Minimum quick-tap deflection duration |
| `RELEASE_NEUTRAL_FRAMES` | `3` | Interruptible release neutral frames |
| `MAX_MOVE_MS` | `15000` | Lost-up / stuck-hold auto-stop |
| `MOVE_STICK_SCALE` | `0.05` | Stick throw fraction |
| `BRIDGE_TOKEN` | *(unset)* | Optional POST auth via `X-Bridge-Token` |

Full list: **[API.md](API.md)**.

When **`GIMBAL_NAME_RE`** is set, the bridge **scans**, connects on match, and keeps retrying in the background (`RECONNECT_MS`). Reconnect policy: [GIMBAL-BLE.md](docs/GIMBAL-BLE.md) **Reconnect**.

## API reference

**[API.md](API.md)** — endpoints, JSON shapes, safety timers, env vars.

**[RONIN.md](RONIN.md)** — how the Ronin app builds the same BLE frames (command bytes, stick write, heart, notify, sleep).

## Project layout

```
server.mjs              HTTP API + static UI
lib/                    BLE session, DUML, telemetry, session-setup
lib/session-setup.js    Connect prologue, heartbeat, recenter, sleep/wake frames
RONIN.md                Ronin app BLE protocol (command bytes, stick, heart, notify, sleep)
public/                 Status web UI (BLE link, Move, Motor, events)
capture-samples.json    Pairing + move frame templates (from protocol capture)
move-presets.json       Neutral / move frame presets
site.env.example        kit template → copy to gitignored site.env
scripts/
  deploy.sh             rsync + install (reads site.env)
  apply-site-env.sh     merge site.env runtime keys → /etc/rs3mini-bridge.env
  setup-prereqs.sh      apt, Node 20, BlueZ, capabilities
  install.sh            npm ci + apply site.env + systemd (on bridge host)
dev/                    calib + vision bench scripts — see dev/README.md
```

## Troubleshooting

| Symptom | Check |
|---------|--------|
| `NO GIMB` | Gimbal powered? No other BLE central (phone Ronin)? Pi within ~3 ft? See [docs/GIMBAL-BLE.md](docs/GIMBAL-BLE.md) **Ghost BLE & remote reset** |
| `NO GIMB` after a prior disconnect | **Ghost BLE** — gimbal may still think it's connected (stops advertising). Bridge runs **`bluetoothctl disconnect`** on Linux (Pi-side only). **Recovery: gimbal power button** at **CF tripod** — no remote reset on battery-only rig |
| `CONN…` long then fail | Pi connect can take **30–45 s** — see logs; wake gimbal |
| Stuck `NO GIMB` / no reconnect events | Gimbal off at boot is OK — should see `scan` events every ~5 s; if silent, `sudo systemctl restart rs3mini-bridge`; if Pi BLE wedged (`poweredOn` timeout), **reboot Pi** |
| `discoverServices timed out` | Often stale link after idle drop — **gimbal power button** at **CF tripod**; `sudo systemctl restart rs3mini-bridge` |
| `npm run scan` shows `(no name)` only | On Pi, try **`bluetoothctl scan on`** — noble may miss names the bridge also needs. Don't run scan while **`rs3mini-bridge`** service is active |
| Motion blocked after boot | `STARTUP_GUARD_MS` / `CONNECT_GUARD_MS` — wait or adjust env |
| HTTP unreachable | Bridge stopped, wrong host/port, or firewall |

## License

MIT — see **[LICENSE](LICENSE)**.

## Disclaimer

Unofficial project — not affiliated with DJI. Use at your own risk. Reverse-engineered BLE traffic; firmware updates may break compatibility.
