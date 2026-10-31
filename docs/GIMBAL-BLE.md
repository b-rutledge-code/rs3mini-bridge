# Gimbal BLE bridge — field notes (public)

HTTP → BLE bridge for **DJI Ronin RS 3 Mini**. Run near the gimbal; control over LAN HTTP.

**Private rig docs** (SSIDs, DHCP, cart topology) live in the operator’s streaming workspace — not this repo.

## Architecture

```text
Stream Deck / Companion  --HTTP :8787-->  bridge host (e.g. Pi)
                                              |
                                         BLE (noble child)
                                              |
                                         RS 3 Mini
```

- **Parent** (`server.mjs` / `app.mjs`): HTTP API, Wi‑Fi status poll, BLE child watchdog  
- **Child** (`ble-worker.mjs`): noble / gimbal session  
- **Filter:** `GIMBAL_NAME_RE` = unit suffix from the gimbal LCD / DJI app (set in env — do not commit real suffixes)

## Companion Page 3 (typical)

| Control | HTTP |
|---------|------|
| D-pad hold / release | `POST /move/hold`, `POST /move/stop` |
| CTR | `POST /center` |
| Motor | `POST /motor/toggle` · poll `GET /motor` |
| BT status + RSSI | `GET /health/label`, `GET /health/ble/rssi` |
| Wi‑Fi status + RSSI | `GET /health/wifi`, `GET /health/wifi/rssi` |
| Battery % | `GET /health/battery` |

**Fail closed:** Companion stores HTTP status from `GET /health/label` in `gimbal_http`; status keys stay red/`DOWN` unless status is **200** (no per-tick `DOWN` preset).

Color ranges (Companion feedbacks): BT RSSI ≥ −65 / ≥ −75; Wi‑Fi ≥ −55 / ≥ −70; battery % ≥ 50 / ≥ 20.

Full HTTP reference: [API.md](../API.md). Ronin BLE frames: [RONIN.md](../RONIN.md).
