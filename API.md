# rs3mini-bridge — HTTP API

**Server:** `server.mjs` on port **8787** (`PORT`). BLE radio work runs in forked `ble-worker.mjs` — [GIMBAL-BLE.md](docs/GIMBAL-BLE.md) **HTTP freeze**.

```bash
npm ci
export GIMBAL_NAME_RE=YOURSUFFIX   # unit suffix — required for connect
npm start
```

Base URL: `http://<bridge-host>:8787`. **POST** issues commands; **GET** returns status.

---

## Authentication

Optional **`BRIDGE_TOKEN`** on **POST** command routes — header **`X-Bridge-Token`** or query **`?token=`**.

| POST (commands) | GET (status) |
|-----------------|--------------|
| `/move/hold`, `/move/stop`, `/center`, `/sleep`, `/wake`, `/motor/toggle`, `/telemetry/refresh` | `/health`, `/health/label`, `/motor`, `/state`, `/events`, `/` |

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/move/hold` | Start or refresh stick streaming (hold lease) |
| `POST` | `/move/stop` | Stop move; send neutral stick |
| `POST` | `/center` | Mechanical recenter |
| `POST` | `/sleep` | Motor sleep — battery; **BLE stays up** |
| `POST` | `/wake` | Exit motor sleep |
| `POST` | `/motor/toggle` | AWAKE→sleep, ASLEEP/UNKNOWN→wake |
| `POST` | `/telemetry/refresh` | Re-handshake telemetry (no recenter) |
| `GET` | `/health/label` | BLE link status string |
| `GET` | `/motor` | Motor state: `AWAKE`, `ASLEEP`, or `UNKNOWN` |
| `GET` | `/state` | BLE link + move + motor + telemetry |
| `GET` | `/health` | Bridge process + adapter |
| `GET` | `/events` | Last 20 operator events |
| `GET` | `/` | Status web UI (auto-refresh) |

**POST bodies** use JSON (`Content-Type: application/json`). Query parameters on POST are also accepted.

---

## `GET /health/label`

Returns a JSON-encoded **string** — **BLE link status only** (not move state; see **`/state` → `move`**).

| Label | Meaning |
|-------|---------|
| `"OK"` | BLE connected |
| `"CONN…"` | Connecting / reconnecting |
| `"NO GIMB"` | Bridge up, gimbal not connected |
| `"NO BLE"` | Adapter off or gimbal target unset |

Companion Deck also polls:

| Route | Body |
|-------|------|
| `GET /health/ble/rssi` | BLE RSSI dBm (`number`) or `null` |
| `GET /health/wifi` | `"UP"` / `"DOWN"` (Pi STA) |
| `GET /health/wifi/rssi` | Wi‑Fi RSSI dBm (`number`) or `null` |
| `GET /health/battery` | Gimbal battery % (`0`–`100`) or `null` |

Deck button colors are Companion feedback ranges on these numbers — not bridge color buckets. Companion stores the HTTP status from **`GET /health/label`** in custom var **`gimbal_http`** and fail-closes status keys unless that status is **200** (no per-tick `DOWN` preset). Field policy: [docs/GIMBAL-BLE.md](docs/GIMBAL-BLE.md) *Page 3*.

---

## `GET /state`

```json
{
  "ok": true,
  "ble": {
    "connected": true,
    "connecting": false,
    "lastError": null,
    "rssiDbm": -61,
    "rssiAgeMs": 1200,
    "rssiSource": "live"
  },
  "move": { "active": false, "axis": null },
  "motor": { "state": "AWAKE", "source": "notify", "ageMs": 1200 },
  "telemetry": {
    "tiltDeg": 76.9,
    "panDeg": 0.1,
    "rollDeg": 0,
    "source": "0x04/0x66",
    "layout": "rs3mini-0x66-fixed",
    "ageMs": 412,
    "stale": false,
    "batteryPercent": 57,
    "batteryAgeMs": 118
  },
  "wifi": {
    "iface": "wlan0",
    "connected": true,
    "ssid": "YOUR-SSID",
    "signalDbm": -52,
    "signalPct": null,
    "bssid": "94:83:c4:3c:94:7d",
    "ip4": "192.168.0.50",
    "ageMs": 4200
  }
}
```

| Field | Notes |
|-------|-------|
| **`wifi`** | Pi **`wlan0`** link — polled every **`WIFI_POLL_MS`** (default 15 s); logged to journal on SSID/signal change |
| **`wifi.signalDbm`** | From **`iw dev wlan0 link`** when available |
| **`wifi.signalPct`** | NM fallback (0–100) when **`iw`** unavailable |
| **`batteryPercent`** | From gimbal notify; matches LCD when link is up |
| **`ble`**, **`move`** | Bridge session state |
| **`ble.rssiDbm`** | Last BLE RSSI (scan at discover; **`live`** via `updateRssi` every **`BLE_RSSI_POLL_MS`**, default 5 s) — status UI under Gimbal badge |
| **`motor.state`** | `AWAKE` or `ASLEEP`. Connect starts `AWAKE`. `POST /sleep` and `POST /wake` set it on the write. A later notify updates it: `0x04/0x0f` (`23 01 11` asleep / `10` awake) or `0x04/0x27` (payload byte 4, bit 0). |
| **`motor.source`** | Who caused the current state: `command` (bridge write), `handle` (a notify changed it), `connect` (session up, no notify yet). A repeat of the same state keeps the existing source. The bridge write still claims the state if the notify arrived first. |
| **`tiltDeg`**, **`panDeg`**, **`rollDeg`** | **`0x66` wire @2/@8** — relative trim only; **not** calibrated aim. Trust policy: [docs/GIMBAL-BLE.md](docs/GIMBAL-BLE.md) **Pan/tilt calibration** |
| **`stale`** | `true` if disconnected or no fresh pose within `TELEMETRY_STALE_MS` (default 3000) |

---

## `GET /motor`

Returns a JSON-encoded string:

```json
"AWAKE"
```

| Value | Meaning |
|-------|---------|
| **`AWAKE`** | Motors on (or default after connect) |
| **`ASLEEP`** | Motor sleep |
| **`UNKNOWN`** | Bridge up, gimbal not connected |

---

## `GET /events`

Last **20** events, newest first. Cleared on restart.

| `kind` | When |
|--------|------|
| `connect` / `disconnect` / `reconnect` | BLE link |
| `move` / `stop` | Move start / stop |
| `center` | Recenter done |
| `motor` | Sleep/wake state change (notify) |
| `sleep` / `wake` | Motor command sent |
| `scan` | Background reconnect attempt |
| `guard` | Startup or connect guard blocked motion |
| `watchdog` | Optional `MOVE_HOLD_MS` lease expiry or `MAX_MOVE_MS` auto-stop |
| `error` | Connect failure |

---

## `POST /move/hold`

Set the current desired stick direction. Companion Page 3: **button down** → this route; **button up** → `POST /move/stop`. A single writer streams the latest direction; a new direction replaces the previous one immediately. No move FIFO. Sign only: **`pan`** ±1, **`tilt`** ±1. Throw is **`MOVE_STICK_SCALE`** (default **0.05**; **`1`** = full). If the gimbal is not already linked, the call is discarded (`503`) — it does not start a BLE connect.

Same-axis call while already moving returns `{ "refreshed": true }` and renews an optional orphan lease only.

```bash
curl -X POST http://127.0.0.1:8787/move/hold \
  -H 'Content-Type: application/json' \
  -d '{"tilt":1}'
```

**Response `200`:** `{ "ok": true, "axis": "tilt+", "active": true, … }`

**Errors:** `400` both zero · `401` token · `503` disconnected / guard / motor asleep · `500` BLE error

---

## `POST /move/stop`

Finger-up for the current d-pad press. Page 3 uses this on release:

- Release before **`HOLD_PROMOTE_MS`** (default **250**) → tap: keep deflection for at least **`NUDGE_MS`** (default **180**) from finger-down, then neutral. Tap travel is bounded by the 180 ms floor and 250 ms classification cutoff.
- Release after promotion → neutral immediately.
- Idle stop → cheap no-op.

Neutral uses **`RELEASE_NEUTRAL_FRAMES`** (default **3**) frames in the same writer and is interruptible by a newer direction.

```bash
curl -X POST http://127.0.0.1:8787/move/stop
```

**Response `200` (hold):** `{ "ok": true, "stopped": true, "nudge": false, "axis": "tilt+" }`

**Response `200` (quick tap):** `{ "ok": true, "stopped": false, "nudge": true, "remainingMs": … }`

---

## `POST /center`

Mechanical recenter **`0x04/0x4c`**. When the session is already up (connect prologue / telemetry setup done), sends the recenter tap only — **no** connect prologue stick poke. Cold path runs full recenter session. Typical ~**1 s** when linked; longer on first cold recenter.

```bash
curl -X POST http://127.0.0.1:8787/center
```

**Response `200`:** `{ "ok": true, "centered": true, "name": "…" }`

Not the same as **`POST /move/stop`**.

---

## `POST /telemetry/refresh`

Re-send connect prologue + **`0x12`** heartbeat **without** **`0x04/0x4c`** recenter. Use when **`GET /state`** is stuck on static **`0x04/0x10`** telemetry.

```bash
curl -X POST http://127.0.0.1:8787/telemetry/refresh
```

**Response `200`:** `{ "ok": true, "refreshed": true, "source": "0x04/0x66", "tiltRaw": …, "panRaw": …, "name": "…" }`

Does **not** move the gimbal. If **`0x66`** still does not appear, use **`POST /center`** or gimbal power cycle.

---

## `POST /track/replay` (bench)

Ronin Track **`0x62`** path upload + **`0x6b`** follow. **Blocks** for **`followMs`** (~20 s default). Not for Companion / field — bench validation only.

```bash
curl -X POST http://127.0.0.1:8787/track/replay \
  -H 'Content-Type: application/json' \
  -d '{"mode":"stage0g"}'
```

| Body field | Meaning |
|------------|---------|
| **`mode: "stage0g"`** | Replay captured two-point path (up → down) |
| **`payloadHex`** | Custom **`0x62`** blob (≥2 waypoints) |
| **`pollMs`**, **`prePolls`**, **`followMs`** | Track session timing |

CLI: **`npm run waypoint:from-bridge -- stage0g`** with **`BRIDGE_URL`** set.

---

## `POST /motor/toggle`

Sleep if motor is **AWAKE**; wake if **ASLEEP** or **UNKNOWN**.

```bash
curl -X POST http://127.0.0.1:8787/motor/toggle
```

**Response `200`:** `{ "ok": true, "toggle": true, "sleep": true, "motor": "ASLEEP", … }` or `{ "wake": true, "motor": "AWAKE", … }`

---

## `POST /sleep` · `POST /wake`

Motor sleep/wake via **`0x04/0x0f`** payload **`23 01 11`** (sleep) / **`23 01 10`** (wake). BLE stays connected; **`/health/label`** should remain **`OK`**.

```bash
curl -X POST http://127.0.0.1:8787/sleep
curl -X POST http://127.0.0.1:8787/wake
```

**Response `200`:** `{ "ok": true, "sleep": true, "motor": "ASLEEP", … }`

Does **not** clear a stuck BLE central slot on the **gimbal** — use **power button** at the **CF tripod**. Battery-only field rig has **no remote power cycle**. See [docs/GIMBAL-BLE.md](docs/GIMBAL-BLE.md) **Ghost BLE**.

---

## `GET /health`

Bridge process — not gimbal link status (use **`/health/label`**).

```json
{ "ok": true, "adapter": "poweredOn", "gimbalTarget": "name~/YOURSUFFIX/i" }
```

---

## Environment

| Env | Default | Effect |
|-----|---------|--------|
| `GIMBAL_NAME_RE` | *(required)* | Unit suffix in advertised name (e.g. `YOURSUFFIX` → `DJI RS3 MINI-YOURSUFFIX`). Bridge scans; this filters ads. |
| `PORT` | `8787` | HTTP listen port |
| `RECONNECT_MS` | `5000` | Background reconnect tick (`0` = off). Policy: [GIMBAL-BLE.md](docs/GIMBAL-BLE.md) **Reconnect** |
| `STARTUP_GUARD_MS` | `5000` | Blocks `POST /move/hold` after boot |
| `CONNECT_GUARD_MS` | `8000` | Blocks motion after BLE connect |
| `MOVE_HOLD_MS` | `0` | Optional orphan silence → neutral (`0` = off; Page 3 uses `/move/stop` on release) |
| `HOLD_PROMOTE_MS` | `250` | Release before this is a tap; release after this is a hold |
| `NUDGE_MS` | `180` | Minimum deflection duration from finger-down for a quick tap |
| `RELEASE_NEUTRAL_FRAMES` | `3` | Interruptible neutral frames after release |
| `MAX_MOVE_MS` | `15000` | Absolute auto-stop if a hold never gets `/move/stop` (`MAX_HOLD_MS` alias) |
| `MOVE_STICK_SCALE` | `0.05` | Fraction of Stage 0d stick throw for `POST /move/hold` (clamp `(0, 1]`; `1` = full) |
| `CONNECT_TIMEOUT_MS` | `45000` | ACL `connectAsync` watchdog |
| `BLE_RSSI_POLL_MS` | `5000` | Live RSSI refresh while connected (`0` = scan-only) |
| `CONNECT_TOTAL_MS` | `160000` | Coalesce backstop (scan + ACL + relink + GATT) |
| `CONNECT_STALE_MS` | *(same as `CONNECT_TOTAL_MS`)* | Coalesce wait for the in-flight attempt |
| `CONNECT_DELAY_MS` | `500` | Pause after connect before GATT discovery |
| `GATT_DISCOVER_MS` | `15000` | Service/characteristic discovery timeout |
| `GATT_DISCOVER_RETRIES` | `2` | Retry when `discoverServices([])` returns empty |
| `BRIDGE_TOKEN` | *(unset)* | Optional POST auth via `X-Bridge-Token` |
| `WIFI_IFACE` | `wlan0` | Interface for link poll |
| `WIFI_POLL_MS` | `15000` | Wi‑Fi poll interval; logs to journal on SSID/signal change (`0` = off) |
| `BLE_WORKER_STALE_MS` | `CONNECT_TOTAL_MS` + 20 s | Parent SIGKILL + respawn if child heartbeat is this old (must outlast a blocked ACL) |
| `BLE_WORKER_FAULT` | *(unset)* | `block` — child spins the event loop after connect (watchdog bench only) |

`POST /move/stop`, `POST /center`, `POST /sleep`, `POST /wake`, and `POST /telemetry/refresh` are never blocked by motion guards.

---

## Bench calibration (dev)

**Policy and results:** [docs/GIMBAL-BLE.md](docs/GIMBAL-BLE.md) **Pan/tilt calibration**.

| npm script | Purpose |
|------------|---------|
| `calib:from-bridge` | Snapshot pose via running bridge → `calibration-poses.jsonl` |
| `calib:phase-a` | Axis direction proof (CTR + four nudges) |
| `calib:pan-negative` | Pan @8 range probe (pan+ hold → pan− hold) |
| `calib:track-bench` | `0x14` stage0g/mark wire + `0x62` stage0g battery |
| `calib:014-roundtrip` | `0x14` recall to markA/B after nudge away |
| `waypoint:from-bridge` | `POST /track/replay` (`stage0g` \| `capture` \| `hex`) |
| `calib:closed-loop` | Wire-target nudge loop (`TARGET_STEP` or `TARGET_TILT`/`TARGET_PAN`) |
| `calib:analyze` | Summarize JSONL |
| `vision:grab` | One Larix JPEG (`RTSP_URL` in `.local/vision.env`) |
| `vision:learn` | Incremental wire+SSIM learn → `vision-understanding.json` |
| `vision:learn:tilt+` | Drive **tilt+** until @2 sign locked (6 s hold) |
| `vision:learn:pan+` | Drive **pan+** until @8 sign locked |

Set **`BRIDGE_URL`** when not on localhost (e.g. `http://10.0.0.183:8787`). Vision bench also needs **`RTSP_URL`** — see [dev/README.md](dev/README.md). Legacy **`calib:grid`** etc. require stopping **`rs3mini-bridge`** first.
